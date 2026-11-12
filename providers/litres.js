// ЛитРес — партнёрский API «для интеграции партнёров».
// Документация: https://docs.litres.ru/public/205502033.html
//
// У API нет поиска: партнёр выгружает каталог (JSONL) и хранит его у себя,
// а аудиофайлы получает по временным ссылкам (живут 5 минут). Поэтому адаптер:
//   1) синхронизирует каталог в data/litres-catalog.jsonl (только аудиокниги);
//   2) ищет по локальной копии;
//   3) выдаёт аудио через resolveTrack() — сервер проксирует его плееру.
//
// Нужны LITRES_PARTNER_ID и LITRES_SECRET_KEY — их выдаёт ЛитРес по договору.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const { Readable } = require('stream');
const { stripHtml } = require('./util');

const API = 'https://api.litres.ru/integrations';
const COVERS = 'https://cdn.litres.ru';
const DATA_DIR = path.join(__dirname, '..', 'data');
const CATALOG_FILE = path.join(DATA_DIR, 'litres-catalog.jsonl');
const STATE_FILE = path.join(DATA_DIR, 'litres-state.json');
const RESYNC_MS = 6 * 60 * 60 * 1000; // обновлять каталог раз в 6 часов

const partnerId = () => process.env.LITRES_PARTNER_ID || '';
const secretKey = () => process.env.LITRES_SECRET_KEY || '';

// --- запросы к API ----------------------------------------------------------
async function call(method, pathname, params = {}) {
  const ts = Math.floor(Date.now() / 1000);
  // Подпись: HMAC-SHA256 от "{timestamp}.{partner_id}" секретным ключом, живёт 5 минут.
  const signature = crypto.createHmac('sha256', secretKey()).update(`${ts}.${partnerId()}`).digest('hex');
  let url = API + pathname;
  let body;
  if (method === 'GET') url += '?' + new URLSearchParams({ partner_id: partnerId(), ...params });
  else body = JSON.stringify({ partner_id: Number(partnerId()), ...params });

  const res = await fetch(url, {
    method,
    body,
    headers: { Timestamp: String(ts), Signature: signature, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`ЛитРес: ${data.error?.title || data.error?.type || 'HTTP ' + res.status}`);
    err.status = res.status;
    throw err;
  }
  return data.payload?.data;
}

// --- цена: ЛитРес отдаёт рубли, платёжная система может их не принимать ------
// LITRES_CURRENCY — валюта, в которой продаём (по умолчанию usd; rub — без пересчёта).
// LITRES_RUB_RATE — сколько рублей в единице валюты; если не задан, берём курс ЦБ РФ.
const currency = () => (process.env.LITRES_CURRENCY || 'usd').toLowerCase();
let rateCache = { value: 0, at: 0 };

async function rubPerUnit() {
  if (currency() === 'rub') return 1;
  if (Number(process.env.LITRES_RUB_RATE) > 0) return Number(process.env.LITRES_RUB_RATE);
  if (rateCache.value && Date.now() - rateCache.at < 12 * 60 * 60 * 1000) return rateCache.value;
  const res = await fetch('https://www.cbr.ru/scripts/XML_daily.asp', {
    headers: { 'User-Agent': 'Mozilla/5.0 audiobook-app' },
    signal: AbortSignal.timeout(15000),
  });
  const xml = await res.text();
  const code = currency().toUpperCase();
  const m = xml.match(new RegExp(`<CharCode>${code}</CharCode>\\s*<Nominal>(\\d+)</Nominal>.*?<Value>([\\d,]+)</Value>`, 's'));
  if (!m) throw new Error(`ЛитРес: нет курса ЦБ для ${code} — задайте LITRES_RUB_RATE`);
  rateCache = { value: Number(m[2].replace(',', '.')) / Number(m[1]), at: Date.now() };
  return rateCache.value;
}

async function toPrice(rub) {
  if (!(rub > 0)) return null;
  const rate = await rubPerUnit();
  return { amount: Math.max(50, Math.ceil((rub / rate) * 100)), currency: currency() };
}

// --- локальный каталог ------------------------------------------------------
const index = new Map(); // id -> компактная запись
let loaded = false;
let syncing = null;

// Полные аудиофайлы книги: группа MP3 без ознакомительных фрагментов и архивов.
function audioFiles(groups) {
  const candidates = (groups || []).filter(
    (g) => !/фрагмент/i.test(g.group_name || '') && g.files?.length && g.files.every((f) => f.type === 'audio/mpeg')
  );
  const group = candidates.find((g) => g.id === 3) || candidates[0];
  return (group?.files || []).map((f) => ({ id: f.id, sec: f.seconds_count || null }));
}

const names = (persons, role) =>
  (persons || []).filter((p) => p.role === role).map((p) => p.full_name || `${p.first_name || ''} ${p.last_name || ''}`.trim()).filter(Boolean).join(', ');

function compact(d) {
  const files = audioFiles(d.file_groups);
  return {
    id: d.id,
    title: d.title,
    author: names(d.persons, 0),
    reader: names(d.persons, 6),
    cover: d.cover_url || null,
    rub: Number(d.price?.value) || 0,
    lang: d.language_code || null,
    rating: d.yearly_rating || 0,
    sec: files.reduce((sum, f) => sum + (f.sec || 0), 0) || null,
    files,
    about: stripHtml(d.html_annotation).slice(0, 1500),
  };
}

function loadFromDisk() {
  if (loaded) return;
  loaded = true;
  if (!fs.existsSync(CATALOG_FILE)) return;
  for (const line of fs.readFileSync(CATALOG_FILE, 'utf8').split('\n')) {
    if (!line) continue;
    const item = JSON.parse(line);
    index.set(item.id, item);
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

// Выгрузка каталога: заказать файл -> дождаться готовности -> скачать и разобрать построчно.
async function sync() {
  loadFromDisk();
  const state = readState();
  const startedAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 19); // с запасом в сутки
  const incremental = index.size > 0 && state.lastUpdatedAt;

  const { catalog_id } = await call('POST', '/api/partner/catalog/new', incremental ? { last_updated_at: state.lastUpdatedAt } : {});
  let url = null;
  for (let i = 0; i < 360 && !url; i++) {
    const s = await call('GET', '/api/partner/catalog/status', { catalog_id });
    if (s.status === 'failed') throw new Error('ЛитРес: не удалось сформировать каталог');
    if (s.status === 'success') url = s.download_url;
    else await new Promise((r) => setTimeout(r, 5000));
  }
  if (!url) throw new Error('ЛитРес: каталог формируется слишком долго');

  const res = await fetch(url);
  if (!res.ok) throw new Error(`ЛитРес: каталог не скачался (HTTP ${res.status})`);
  const lines = readline.createInterface({ input: Readable.fromWeb(res.body).pipe(zlib.createGunzip()) });
  let changed = 0;
  for await (const line of lines) {
    if (!line) continue;
    const d = JSON.parse(line);
    if (d.merged_from) index.delete(d.merged_from);
    const item = d.type === 1 && d.is_available && d.status === 1 ? compact(d) : null;
    // Книга снята с продажи или у неё нет аудио — убираем из витрины.
    if (item && item.files.length) index.set(d.id, item);
    else index.delete(d.id);
    changed++;
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const out = fs.createWriteStream(CATALOG_FILE + '.tmp');
  for (const item of index.values()) out.write(JSON.stringify(item) + '\n');
  await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  fs.renameSync(CATALOG_FILE + '.tmp', CATALOG_FILE);
  fs.writeFileSync(STATE_FILE, JSON.stringify({ lastUpdatedAt: startedAt, syncedAt: Date.now() }));
  console.log(`ЛитРес: каталог обновлён (${changed} изменений, аудиокниг в витрине: ${index.size})`);
}

function startSync() {
  if (!syncing) {
    syncing = sync()
      .catch((e) => {
        console.error(e.message);
        throw e;
      })
      .finally(() => (syncing = null));
    syncing.catch(() => {});
  }
  return syncing;
}

// Каталог готов к поиску; при первом запуске ждём выгрузку, потом обновляем в фоне.
async function ready() {
  loadFromDisk();
  const fresh = Date.now() - (readState().syncedAt || 0) < RESYNC_MS;
  if (!index.size && !fresh) {
    const waited = await Promise.race([startSync().then(() => true), new Promise((r) => setTimeout(() => r(false), 25000))]);
    if (!waited) throw new Error('ЛитРес: каталог ещё загружается, повторите поиск позже');
  } else if (!fresh) {
    startSync();
  }
}

async function toSummary(item) {
  return {
    provider: 'litres',
    id: String(item.id),
    title: item.title,
    author: item.author || 'Автор не указан',
    cover: item.cover ? COVERS + item.cover : null,
    durationSec: item.sec,
    language: item.lang,
    price: await toPrice(item.rub),
  };
}

// --- временные ссылки на аудио ----------------------------------------------
const links = new Map(); // fileId -> { url, expires }

module.exports = {
  id: 'litres',
  name: 'ЛитРес',
  paid: true,
  enabled: () => Boolean(partnerId() && secretKey()),
  sync: startSync,

  async search(q) {
    await ready();
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const found = [];
    for (const item of index.values()) {
      const text = `${item.title} ${item.author}`.toLowerCase();
      if (words.every((w) => text.includes(w))) found.push(item);
    }
    found.sort((a, b) => b.rating - a.rating);
    return Promise.all(found.slice(0, 30).map(toSummary));
  },

  async getBook(id) {
    await ready();
    const item = index.get(Number(id));
    if (!item) return null;
    return {
      ...(await toSummary(item)),
      description: [item.about, item.reader && `Читает: ${item.reader}.`].filter(Boolean).join(' '),
      // url нет: сервер подставит адрес своего прокси и вызовет resolveTrack().
      tracks: item.files.map((f, i) => ({
        title: item.files.length > 1 ? `Часть ${i + 1}` : item.title,
        trackId: String(f.id),
        durationSec: f.sec,
      })),
    };
  },

  // -> действующая ссылка на файл; null, если файл не относится к этой книге.
  async resolveTrack(bookId, trackId) {
    await ready();
    const item = index.get(Number(bookId));
    if (!item?.files.some((f) => String(f.id) === String(trackId))) return null;
    const cached = links.get(trackId);
    if (cached && cached.expires > Date.now()) return cached.url;
    const { link } = await call('GET', `/api/partner/file/${trackId}/link`);
    links.set(trackId, { url: link, expires: Date.now() + 4 * 60 * 1000 }); // ссылка живёт 5 минут
    return link;
  },
};
