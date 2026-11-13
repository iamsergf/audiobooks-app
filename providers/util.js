// Общие помощники для адаптеров провайдеров.

async function getJson(url, { headers = {}, timeoutMs = 15000 } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'audiobook-app/1.0', Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} от ${new URL(url).host}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// "507.1" | "08:26" | "1:12:14" -> секунды
function parseDuration(value) {
  if (value == null || value === '') return null;
  const s = String(value);
  if (!s.includes(':')) {
    const n = Number(s);
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  const parts = s.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return Math.round(parts.reduce((acc, n) => acc * 60 + n, 0));
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// Провайдеры пишут язык по-разному ("rus", "Russian", "ru") — приводим к коду "ru" / "en".
function langCode(value) {
  const v = String(value || '').toLowerCase();
  if (['ru', 'rus', 'russian', 'русский'].includes(v)) return 'ru';
  if (['en', 'eng', 'english'].includes(v)) return 'en';
  return v || null;
}

// Все слова из needle встречаются в text (без учёта регистра). Пустой needle подходит всегда.
function matches(text, needle) {
  const hay = String(text || '').toLowerCase();
  return String(needle || '').toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

module.exports = { getJson, parseDuration, stripHtml, langCode, matches };
