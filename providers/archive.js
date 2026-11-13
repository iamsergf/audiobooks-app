// Internet Archive — раздел аудиокниг и поэзии. Ключ API не нужен.
// Поиск: https://archive.org/advancedsearch.php, метаданные: https://archive.org/metadata/{id}
const { getJson, parseDuration, stripHtml, langCode } = require('./util');

const LANGUAGES = { ru: 'rus OR Russian OR ru', en: 'eng OR English OR en' };
const clean = (s) => String(s || '').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim();

const first = (v) => (Array.isArray(v) ? v[0] : v);

function toSummary(id, meta) {
  return {
    provider: 'archive',
    id,
    title: first(meta.title) || id,
    author: [].concat(meta.creator || []).join(', ') || 'Неизвестный автор',
    cover: `https://archive.org/services/img/${encodeURIComponent(id)}`,
    durationSec: parseDuration(first(meta.runtime)),
    language: langCode(first(meta.language)),
    price: null,
  };
}

module.exports = {
  id: 'archive',
  name: 'Internet Archive',
  paid: false,

  async search(q, filters = {}) {
    const [safe, author, reader] = [clean(q), clean(filters.author), clean(filters.reader)];
    let query = 'collection:audio_bookspoetry AND mediatype:audio';
    if (safe) query += ` AND (title:(${safe}) OR creator:(${safe}))`;
    if (author) query += ` AND creator:(${author})`;
    // Отдельного поля «чтец» в архиве нет — имя чтеца обычно указано в описании.
    if (reader) query += ` AND description:(${reader})`;
    if (LANGUAGES[filters.lang]) query += ` AND language:(${LANGUAGES[filters.lang]})`;
    const params = new URLSearchParams({ q: query, rows: '20', output: 'json' });
    for (const f of ['identifier', 'title', 'creator', 'runtime', 'language']) params.append('fl[]', f);
    params.append('sort[]', 'downloads desc');
    const data = await getJson('https://archive.org/advancedsearch.php?' + params);
    return (data.response?.docs || []).map((d) => toSummary(d.identifier, d));
  },

  async getBook(id) {
    if (!/^[\w.-]+$/.test(id)) return null;
    const data = await getJson(`https://archive.org/metadata/${id}`);
    if (!data.metadata) return null;

    let mp3 = (data.files || []).filter((f) => /\.mp3$/i.test(f.name));
    // У одной главы обычно несколько файлов разного битрейта — берём по одному набору.
    const originals = mp3.filter((f) => f.source === 'original');
    if (originals.length) mp3 = originals;
    mp3.sort(
      (a, b) =>
        (Number(a.track) || 1e9) - (Number(b.track) || 1e9) ||
        a.name.localeCompare(b.name, 'en', { numeric: true })
    );

    return {
      ...toSummary(id, data.metadata),
      description: stripHtml(first(data.metadata.description)),
      tracks: mp3.map((f, i) => ({
        title: f.title || `Часть ${i + 1}`,
        url: `https://archive.org/download/${id}/${encodeURIComponent(f.name)}`,
        durationSec: parseDuration(f.length),
      })),
    };
  },
};
