// LibriVox — бесплатные аудиокниги (общественное достояние). Ключ API не нужен.
// Документация: https://librivox.org/api/info
const { getJson, stripHtml } = require('./util');

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
    language: b.language || null,
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

  async search(q) {
    if (!q) return (await query({ limit: '20' })).map(toSummary);
    // API ищет по началу названия (^) и по фамилии автора — объединяем оба запроса.
    const [byTitle, byAuthor] = await Promise.all([
      query({ title: '^' + q, limit: '15' }),
      query({ author: q.split(/\s+/).pop(), limit: '15' }),
    ]);
    const seen = new Set();
    return [...byTitle, ...byAuthor]
      .filter((b) => !seen.has(b.id) && seen.add(b.id))
      .map(toSummary);
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
