// Демо-магазин — пример ПЛАТНОГО провайдера, чтобы можно было проверить оплату.
// Каталог лежит в demostore.catalog.json; аудио для примера берётся из Internet Archive
// (книги в общественном достоянии). Для настоящего магазина замените этот адаптер
// на вызовы API вашего поставщика — см. _template.js.
const catalog = require('./demostore.catalog.json');
const archive = require('./archive');
const { matches } = require('./util');

const toSummary = (b) => ({
  provider: 'demostore',
  id: b.id,
  title: b.title,
  author: b.author,
  cover: `https://archive.org/services/img/${b.archiveId}`,
  durationSec: null,
  language: 'en',
  price: b.price,
});

module.exports = {
  id: 'demostore',
  name: 'Демо-магазин (платный)',
  paid: true,

  async search(q, filters = {}) {
    if (filters.reader || (filters.lang && filters.lang !== 'en')) return [];
    return catalog
      .filter((b) => matches(`${b.title} ${b.author}`, q) && matches(b.author, filters.author))
      .map(toSummary);
  },

  async getBook(id) {
    const item = catalog.find((b) => b.id === id);
    if (!item) return null;
    const source = await archive.getBook(item.archiveId);
    return {
      ...toSummary(item),
      durationSec: source?.durationSec ?? null,
      description: source?.description || '',
      tracks: source?.tracks || [],
    };
  },
};
