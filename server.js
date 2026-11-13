// Сервер приложения аудиокниг. Без зависимостей: нужен только Node.js 18+.
// Запуск: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

// --- .env -------------------------------------------------------------------
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const providers = require('./providers');
const payments = require('./payments');
const litres = require('./providers/litres');

const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = path.join(__dirname, 'data', 'purchases.json');

// --- покупки (JSON-файл; для продакшена замените на базу данных) -------------
let purchases = {};
try {
  purchases = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch {}

const owned = (uid) => purchases[uid] || [];
function grant(uid, item) {
  if (owned(uid).includes(item)) return;
  purchases[uid] = [...owned(uid), item];
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(purchases, null, 2));
}

// Книгу можно слушать, если она бесплатная, куплена здесь или уже есть в аккаунте у провайдера.
const isUnlocked = (book, uid) =>
  !book.price || book.owned === true || owned(uid).includes(`${book.provider}:${book.id}`);

// --- помощники --------------------------------------------------------------
function send(res, status, body, headers = {}) {
  const json = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    ...headers,
  });
  res.end(json ? JSON.stringify(body) : body);
}

// Анонимный идентификатор пользователя в cookie. Для настоящего сервиса
// замените на полноценную регистрацию/вход.
function getUid(req, res) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)uid=([a-f0-9]{32})/);
  if (m) return m[1];
  const uid = crypto.randomBytes(16).toString('hex');
  res.setHeader('Set-Cookie', `uid=${uid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
  return uid;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e5) reject(new Error('Слишком большой запрос'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Некорректный JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function loadBook(providerId, id) {
  const provider = providers.get(providerId);
  if (!provider || !id) return null;
  return provider.getBook(String(id));
}

// --- API --------------------------------------------------------------------
const api = {
  'GET /api/config': async (req, res, url, uid) => ({
    providers: providers.list().map((p) => ({ id: p.id, name: p.name, paid: p.paid })),
    paymentMode: payments.mode(), // demo | test | live
    owned: owned(uid),
    litres: litres.enabled() ? { login: litres.account().login } : null,
  }),

  'GET /api/search': async (req, res, url) => {
    const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
    const wanted = (url.searchParams.get('providers') || '').split(',').filter(Boolean);
    const list = providers.list().filter((p) => !wanted.length || wanted.includes(p.id));
    const param = (name) => (url.searchParams.get(name) || '').trim().slice(0, 100);
    const filters = { author: param('author'), reader: param('reader'), lang: param('lang').toLowerCase() };
    const settled = await Promise.allSettled(list.map((p) => p.search(q, filters)));
    const results = [];
    const errors = [];
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled') results.push(...s.value);
      else errors.push({ provider: list[i].name, message: s.reason.message });
    });
    return { results, errors };
  },

  'GET /api/book': async (req, res, url, uid) => {
    const book = await loadBook(url.searchParams.get('provider'), url.searchParams.get('id'));
    if (!book) return send(res, 404, { error: 'Книга не найдена' });
    // Платная книга без покупки: ссылки на аудио не отдаём.
    const locked = !isUnlocked(book, uid);
    // Если провайдер не даёт постоянных ссылок (resolveTrack), аудио идёт через /api/stream.
    book.tracks = book.tracks.map((t) => ({
      title: t.title,
      durationSec: t.durationSec,
      url: locked
        ? null
        : t.url || '/api/stream?' + new URLSearchParams({ provider: book.provider, id: book.id, track: t.trackId }),
    }));
    return { ...book, locked };
  },

  // Прокси аудио для провайдеров с временными ссылками: проверяем покупку,
  // берём свежую ссылку у провайдера и передаём поток плееру (с поддержкой перемотки).
  'GET /api/stream': async (req, res, url, uid) => {
    const provider = providers.get(url.searchParams.get('provider'));
    const id = url.searchParams.get('id') || '';
    if (!provider?.resolveTrack) return send(res, 404, { error: 'Не найдено' });
    const book = await provider.getBook(id);
    if (!book) return send(res, 404, { error: 'Книга не найдена' });
    if (!isUnlocked(book, uid)) {
      return send(res, 402, { error: 'Книга не куплена' });
    }
    const link = await provider.resolveTrack(id, url.searchParams.get('track') || '');
    if (!link) return send(res, 404, { error: 'Файл не найден' });

    const abort = new AbortController();
    res.on('close', () => abort.abort());
    const upstream = await fetch(link, {
      headers: req.headers.range ? { Range: req.headers.range } : {},
      signal: abort.signal,
    });
    // Вместо аудио провайдер может вернуть страницу с ошибкой (например, «книга не куплена»).
    const type = upstream.headers.get('content-type') || '';
    if (!upstream.ok || !upstream.body || !/^(audio\/|application\/octet-stream)/.test(type)) {
      abort.abort();
      return send(res, 502, { error: 'Провайдер не отдал аудио' });
    }
    const headers = { 'Cache-Control': 'private, no-store' };
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      if (upstream.headers.get(h)) headers[h] = upstream.headers.get(h);
    }
    res.writeHead(upstream.status, headers);
    Readable.fromWeb(upstream.body)
      .on('error', () => res.destroy())
      .pipe(res);
  },

  'POST /api/checkout': async (req, res, url, uid) => {
    const { provider, id } = await readJson(req);
    const book = await loadBook(provider, id);
    if (!book) return send(res, 404, { error: 'Книга не найдена' });
    if (!book.price) return send(res, 400, { error: 'Эта книга бесплатная' });
    if (book.buyUrl) return send(res, 400, { error: 'Эта книга покупается на сайте провайдера' });
    if (owned(uid).includes(`${book.provider}:${book.id}`)) {
      return send(res, 400, { error: 'Книга уже куплена' });
    }
    // Цена всегда берётся с сервера — клиент не может её подменить.
    return payments.createCheckout({ book, uid, baseUrl: BASE_URL });
  },

  'GET /api/checkout/confirm': async (req, res, url, uid) => {
    const item = await payments.confirmCheckout(url.searchParams.get('session_id') || '', uid);
    if (!item) return send(res, 402, { error: 'Оплата не подтверждена' });
    grant(uid, item);
    return { item, owned: owned(uid) };
  },

  // Вход в личный аккаунт ЛитРес. Пароль уходит только в ЛитРес и не сохраняется.
  'POST /api/litres/login': async (req) => {
    const { login, pwd } = await readJson(req);
    if (!litres.enabled() || !login || !pwd) throw new Error('Укажите логин и пароль');
    await litres.login(String(login), String(pwd));
    return { login: litres.account().login };
  },

  'POST /api/litres/logout': async () => {
    litres.logout();
    return { login: null };
  },

  'GET /api/demo-order': async (req, res, url, uid) => {
    const order = payments.getDemoOrder(url.searchParams.get('token') || '', uid);
    if (!order) return send(res, 404, { error: 'Заказ не найден' });
    return { title: order.title, price: order.price, item: order.item };
  },

  'POST /api/demo-pay': async (req, res, url, uid) => {
    const { token } = await readJson(req);
    const item = payments.completeDemoOrder(String(token || ''), uid);
    if (!item) return send(res, 404, { error: 'Заказ не найден' });
    grant(uid, item);
    return { item };
  },
};

// --- статика ----------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    send(res, 200, data, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
  });
}

// --- сервер -----------------------------------------------------------------
http
  .createServer(async (req, res) => {
    const url = new URL(req.url, BASE_URL);
    const handler = api[`${req.method} ${url.pathname}`];
    if (!handler) {
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
      return send(res, 404, { error: 'Не найдено' });
    }
    try {
      const uid = getUid(req, res);
      const result = await handler(req, res, url, uid);
      if (!res.headersSent) send(res, 200, result);
    } catch (e) {
      if (e.name !== 'AbortError') console.error(`${req.method} ${url.pathname}:`, e.message);
      if (!res.headersSent) send(res, 502, { error: e.message });
      else res.destroy();
    }
  })
  .listen(PORT, () => {
    console.log(`Аудиокниги: ${BASE_URL}`);
    console.log(`Провайдеры: ${providers.list().map((p) => p.name).join(', ')}`);
    console.log(`Оплата: ${{ demo: 'ДЕМО (ключ Stripe не задан, деньги не списываются)', test: 'Stripe, тестовый режим', live: 'Stripe, БОЕВОЙ режим' }[payments.mode()]}`);
  });
