// ЛитРес, ЛИЧНЫЙ аккаунт — API CataLit 2.0 для сторонних программ.
// Документация: https://docs.litres.ru/public/6424295.html
//
// Вы входите под своим аккаунтом ЛитРес, покупаете книги на сайте ЛитРес,
// а приложение ищет по каталогу и проигрывает то, что у вас куплено.
//
// Нужны LITRES_APP_ID и LITRES_APP_SECRET — ID приложения и ключ разработчика.
// Их выдаёт партнёрский отдел ЛитРес (partners@litres.ru).
//
// ВНИМАНИЕ: адаптер написан по документации и НЕ ПРОВЕРЕН на живом API —
// без ключа разработчика ЛитРес не принимает запросы.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { stripHtml, langCode, matches } = require('./util');

const API = 'https://catalit.litres.ru/catalitv2';
const DOWNLOAD = 'https://catalit.litres.ru/pages/download_my_book/';
const COVERS = 'https://cdn.litres.ru/pub/c/cover';
const SESSION_FILE = path.join(__dirname, '..', 'data', 'litres-session.json');

const AUDIOBOOKS = '2'; // atype: только аудиокниги
const AUTHOR = '0'; // типы персон
const READER = '6';
// Группы файлов с полной аудиокнигой в MP3, в порядке предпочтения (128, 192, 64 кбит/с).
const MP3_GROUPS = ['3', '5', '7'];

const appId = () => process.env.LITRES_APP_ID || '';
const appSecret = () => process.env.LITRES_APP_SECRET || '';

// --- запросы ----------------------------------------------------------------
// Подпись: sha256(time + ключ). Один и тот же time нельзя использовать дважды,
// поэтому каждому запросу даём свою секунду.
let lastTime = 0;
function nextTime() {
  lastTime = Math.max(Math.floor(Date.now() / 1000), lastTime + 1);
  return new Date(lastTime * 1000).toISOString().slice(0, 19) + '+00:00';
}

async function call(requests, sid) {
  const time = nextTime();
  const body = {
    app: appId(),
    time,
    sha: crypto.createHash('sha256').update(time + appSecret()).digest('hex'),
    requests,
  };
  if (sid) body.sid = sid;
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ jdata: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => null);
  if (!data) throw new Error(`ЛитРес: неожиданный ответ сервера (HTTP ${res.status})`);
  if (data.success === false) throw new Error(`ЛитРес: ${data.error_message || 'запрос отклонён'}`);
  return data;
}

// --- сессия -----------------------------------------------------------------
// Храним только идентификатор сессии (sid) и логин; пароль не сохраняется.
let session = null;
try {
  session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
} catch {}
let anonymousSid = null;

async function createSid(login, pwd) {
  const data = await call([{ func: 'w_create_sid', id: 'auth', param: { login, pwd } }]);
  if (!data.auth?.success || !data.auth.sid) {
    throw new Error(`ЛитРес: ${data.auth?.error_message || 'не удалось войти'}`);
  }
  return data.auth.sid;
}

// Без входа каталог доступен под анонимной сессией (логин Anonymous, пароль 0 — так в документации).
async function currentSid() {
  if (session?.sid) return session.sid;
  if (!anonymousSid) anonymousSid = await createSid('Anonymous', '0');
  return anonymousSid;
}

async function run(requests) {
  const data = await call(requests, await currentSid());
  for (const r of requests) {
    if (!data[r.id] || data[r.id].success === false) {
      anonymousSid = null; // анонимная сессия могла устареть — в следующий раз получим новую
      throw new Error(`ЛитРес: ${data[r.id]?.error_message || 'ошибка запроса'}${session ? ' (если повторяется — войдите заново)' : ''}`);
    }
  }
  return data;
}

// --- книги ------------------------------------------------------------------
const personNames = (persons, type) =>
  (persons || []).filter((p) => String(p.type) === type).map((p) => p.full_name).filter(Boolean).join(', ');

function toSummary(art) {
  // В примерах документации поля книги лежат то на верхнем уровне, то в catalogue/purchase.
  const c = art.catalogue || art;
  const p = art.purchase || art;
  const free = String(p.free) === '1';
  const rub = Number(p.final_price ?? p.base_price) || 0;
  return {
    provider: 'litres',
    id: String(c.id),
    title: c.title,
    author: personNames(c.persons, AUTHOR) || 'Автор не указан',
    reader: personNames(c.persons, READER) || null,
    cover: `${COVERS}/${c.id}.jpg`,
    durationSec: String(c.type) === '1' ? Number(c.chars) || null : null, // у аудиокниг chars — секунды
    language: langCode(c.lang),
    price: free || !rub ? null : { amount: Math.round(rub * 100), currency: 'rub' },
    // Книга уже есть в вашем аккаунте ЛитРес (куплена или получена).
    owned: free || String(p.my) === '1',
    // Покупка идёт на сайте ЛитРес, а не через приложение.
    buyUrl: `https://www.litres.ru/pages/biblio_book/?art=${c.id}`,
    _annotation: c.annotation,
  };
}

const publicSummary = ({ _annotation, ...book }) => book;

module.exports = {
  id: 'litres',
  name: 'ЛитРес',
  paid: true,
  enabled: () => Boolean(appId() && appSecret()),

  account: () => ({ login: session?.login || null }),

  async login(login, pwd) {
    const sid = await createSid(login, pwd);
    session = { sid, login };
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify(session), { mode: 0o600 });
  },

  logout() {
    session = null;
    fs.rmSync(SESSION_FILE, { force: true });
  },

  async search(q, filters = {}) {
    const list = { atype: AUDIOBOOKS, limit: ['0', '30'] };
    const personName = filters.reader || filters.author;
    let arts;
    if (personName) {
      // Поиск книг по автору или чтецу: сначала находим персону, потом её аудиокниги.
      const found = await run([
        { func: 'r_search_persons', id: 'p', param: { q: personName, type: [filters.reader ? READER : AUTHOR], limit: ['0', '1'] } },
      ]);
      const person = found.p.persons?.[0];
      if (!person) return [];
      const data = await run([
        { func: 'r_person_arts_pop', id: 'a', param: { person: String(person.id), ...list, limit: ['0', '100'] } },
      ]);
      arts = data.a.arts;
    } else if (q.length >= 3) {
      arts = (await run([{ func: 'r_search_arts', id: 'a', param: { q, ...list } }])).a.arts;
    } else if (session) {
      // Пустой запрос — показываем аудиокниги из вашего аккаунта.
      arts = (await run([{ func: 'r_my_arts_all', id: 'a', param: { atype: AUDIOBOOKS, limit: ['0', '200'] } }])).a.arts;
    } else {
      return []; // поиск ЛитРес требует минимум 3 символа
    }

    return (arts || [])
      .map(toSummary)
      .filter(
        (b) =>
          (!personName || matches(b.title, q)) &&
          matches(b.author, filters.author) &&
          matches(b.reader, filters.reader) &&
          (!filters.lang || b.language === filters.lang)
      )
      .map(publicSummary);
  },

  async getBook(id) {
    if (!/^\d+$/.test(String(id))) return null;
    const data = await run([
      { func: 'r_browse_arts', id: 'a', param: { id: [String(id)], anno: '1' } },
      { func: 'r_art_files', id: 'f', param: { art: Number(id) } },
    ]);
    const art = data.a.arts?.[0];
    if (!art) return null;
    const book = toSummary(art);

    const groups = data.f.group || [];
    const group = MP3_GROUPS.map((v) => groups.find((g) => String(g.value) === v)).find((g) => g?.files?.length);
    const files = (group?.files || []).filter((f) => f.mime_type === 'audio/mpeg');

    return {
      ...publicSummary(book),
      durationSec: files.reduce((sum, f) => sum + (Number(f.seconds) || 0), 0) || book.durationSec,
      description: [stripHtml(book._annotation), book.reader && `Читает: ${book.reader}.`].filter(Boolean).join(' '),
      // url нет: сервер подставит адрес своего прокси и вызовет resolveTrack().
      tracks: files.map((f, i) => ({
        title: files.length > 1 ? `Часть ${i + 1}` : book.title,
        trackId: String(f.id),
        durationSec: Number(f.seconds) || null,
      })),
    };
  },

  // -> ссылка на файл купленной книги. Содержит sid, поэтому наружу не отдаётся:
  // сервер сам скачивает по ней аудио и передаёт плееру.
  async resolveTrack(bookId, trackId) {
    if (!session?.sid) throw new Error('ЛитРес: войдите в аккаунт, чтобы слушать');
    if (!/^\d+$/.test(String(bookId)) || !/^\d+$/.test(String(trackId))) return null;
    return DOWNLOAD + '?' + new URLSearchParams({ sid: session.sid, art: String(bookId), file: String(trackId) });
  },
};
