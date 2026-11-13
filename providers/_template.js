// ШАБЛОН адаптера нового провайдера.
// 1. Скопируйте файл (например, в mystore.js) и реализуйте search/getBook.
// 2. Подключите его в providers/index.js.
// 3. Ключ API положите в .env (например, MYSTORE_API_KEY) — он остаётся на сервере
//    и в браузер не попадает.
const { getJson } = require('./util');

const API = 'https://api.example-store.com/v1';
const auth = () => ({ Authorization: `Bearer ${process.env.MYSTORE_API_KEY}` });

module.exports = {
  id: 'mystore', // уникальный идентификатор
  name: 'My Store', // название в интерфейсе
  paid: true, // есть ли платные книги
  enabled: () => Boolean(process.env.MYSTORE_API_KEY), // необязательно: скрыть, если не настроен

  // -> массив кратких карточек.
  // filters: { author, reader, lang } — автор, чтец и язык ("ru" / "en" / пусто — любой).
  // Если API провайдера не умеет какой-то фильтр, отфильтруйте результаты сами.
  async search(q, filters = {}) {
    const data = await getJson(`${API}/books?query=${encodeURIComponent(q)}`, { headers: auth() });
    return data.items.map((b) => ({
      provider: 'mystore',
      id: String(b.id),
      title: b.title,
      author: b.author,
      reader: b.narrator || null, // чтец, если провайдер его отдаёт
      cover: b.coverUrl || null,
      durationSec: b.duration || null,
      language: b.language || null, // "ru", "en"...
      // null — бесплатно; иначе сумма в минимальных единицах валюты (центы)
      price: b.price ? { amount: b.price.cents, currency: b.price.currency.toLowerCase() } : null,
    }));
  },

  // -> карточка + description + tracks; null, если книги нет.
  // Сервер сам скроет tracks у платной книги, пока она не куплена.
  async getBook(id) {
    const b = await getJson(`${API}/books/${encodeURIComponent(id)}`, { headers: auth() });
    return {
      provider: 'mystore',
      id: String(b.id),
      title: b.title,
      author: b.author,
      cover: b.coverUrl || null,
      durationSec: b.duration || null,
      language: b.language || null,
      price: b.price ? { amount: b.price.cents, currency: b.price.currency.toLowerCase() } : null,
      description: b.description || '',
      tracks: b.chapters.map((c) => ({ title: c.title, url: c.streamUrl, durationSec: c.duration })),
    };
  },
};
