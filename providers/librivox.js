// LibriVox — бесплатные аудиокниги (общественное достояние). Ключ API не нужен.
// Документация: https://librivox.org/api/info
const { getJson, stripHtml, langCode, matches } = require('./util');

const BASE = 'https://librivox.org/api/feed/audiobooks/';

function authorName(authors) {
  return (authors || [])
    .map((a) => `${a.first_name || ''} ${a.last_name || ''}`.trim())
    .filter(Boolean)
    .join(', ');
}

function toSummary(b) {
  return {
    provider: 'librivox',
    id: String(b.id),
    title: b.title,
    author: authorName(b.authors) || 'Неизвестный автор',
    cover: (b.coverart_thumbnail || b.coverart_jpg || '').replace('http://', 'https://') || null,
    durationSec: Number(b.totaltimesecs) || null,
    language: langCode(b.language),
    price: null,
  };
}

async function query(params) {
  const url = BASE + '?' + new URLSearchParams({ format: 'json', coverart: '1', ...params });
  try {
    const data = await getJson(url);
    return data.books || [];
  } catch (e) {
    if (e.status === 404) return []; // LibriVox отвечает 404, когда ничего не найдено
    throw e;
  }
}

module.exports = {
  id: 'librivox',
  name: 'LibriVox',
  paid: false,

  async search(q, filters = {}) {
    // API LibriVox не умеет искать по чтецу и по языку: по чтецу ничего не отдаём,
    // язык отсеиваем уже в полученных результатах.
    if (filters.reader) return [];
    const lastName = (s) => s.trim().split(/\s+/).pop();
    let books;
    if (filters.author) {
      books = (await query({ author: lastName(filters.author), limit: '50' })).filter((b) => matches(b.title, q));
    } else if (!q) {
      books = await query({ limit: '20' });
    } else {
      // API ищет по началу названия (^) и по фамилии автора — объединяем оба запроса.
      const [byTitle, byAuthor] = await Promise.all([
        query({ title: '^' + q, limit: '15' }),
        query({ author: lastName(q), limit: '15' }),
      ]);
      books = [...byTitle, ...byAuthor];
    }
    const seen = new Set();
    return books
      .filter((b) => !seen.has(b.id) && seen.add(b.id))
      .map(toSummary)
      .filter((b) => !filters.lang || b.language === filters.lang);
  },

  async getBook(id) {
    const [b] = await query({ id: String(id), extended: '1' });
    if (!b) return null;
    return {
      ...toSummary(b),
      description: stripHtml(b.description),
      tracks: (b.sections || [])
        .slice()
        .sort((x, y) => Number(x.section_number) - Number(y.section_number))
        .filter((s) => s.listen_url)
        .map((s) => ({
          title: s.title || `Глава ${s.section_number}`,
          url: s.listen_url.replace('http://', 'https://'),
          durationSec: Number(s.playtime) || null,
        })),
    };
  },
};
