// Клиент: каталог, карточка книги, покупка и плеер.
const $ = (id) => document.getElementById(id);

// Создание DOM-элементов без innerHTML (данные провайдеров не доверенные).
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
  return data;
}
const post = (path, body) =>
  api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// localStorage может быть недоступен (приватный режим) — приложение работает и без него.
const store = {
  get(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

const nativeBridge = window.webkit?.messageHandlers?.native; // есть только внутри iOS-приложения
const keyOf = (b) => `${b.provider}:${b.id}`;

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}
function fmtLength(sec) {
  if (!sec) return '';
  const hh = Math.floor(sec / 3600);
  const mm = Math.round((sec % 3600) / 60);
  return hh ? `${hh} ч ${mm} мин` : `${mm} мин`;
}
const fmtPrice = (p) =>
  new Intl.NumberFormat('ru-RU', { style: 'currency', currency: p.currency.toUpperCase() }).format(p.amount / 100);

// --- состояние --------------------------------------------------------------
const state = {
  config: { providers: [], owned: [], paymentMode: 'demo' },
  library: store.get('library', {}), // key -> { book: краткая карточка, track, time, updated }
  current: null, // { book, index }
};
const providerName = (id) => state.config.providers.find((p) => p.id === id)?.name || id;
const isOwned = (b) => state.config.owned.includes(keyOf(b));

function remember(book, patch = {}) {
  const { provider, id, title, author, reader, cover, durationSec, price } = book;
  const key = keyOf(book);
  state.library[key] = {
    track: 0,
    time: 0,
    ...state.library[key],
    ...patch,
    book: { provider, id, title, author, reader, cover, durationSec, price },
    updated: Date.now(),
  };
  store.set('library', state.library);
}

// --- карточки ---------------------------------------------------------------
function priceLabel(b) {
  if (!b.price) return h('span', { class: 'price free' }, 'Бесплатно');
  if (isOwned(b) || b.owned) return h('span', { class: 'price owned' }, 'Куплено');
  return h('span', { class: 'price' }, fmtPrice(b.price));
}

function card(b, progress) {
  return h(
    'button',
    { class: 'card', onclick: () => openBook(b.provider, b.id) },
    b.cover
      ? h('img', { src: b.cover, alt: '', loading: 'lazy', onerror: (e) => e.target.replaceWith(h('div', { class: 'ph' })) })
      : h('div', { class: 'ph' }),
    progress != null && h('div', { class: 'progress' }, h('i', { style: `width:${Math.round(progress * 100)}%` })),
    h(
      'div',
      { class: 'info' },
      h('div', { class: 'title' }, b.title),
      h('div', { class: 'author' }, b.author),
      b.reader && h('div', { class: 'reader' }, 'Читает: ' + b.reader),
      h('div', { class: 'foot' }, h('span', {}, providerName(b.provider)), priceLabel(b))
    )
  );
}

function showNotice(text) {
  $('notice').hidden = !text;
  $('notice').textContent = text || '';
}

// --- каталог ----------------------------------------------------------------
let searchSeq = 0;
async function search() {
  const seq = ++searchSeq;
  const selected = [...document.querySelectorAll('#providers input:checked')].map((i) => i.value);
  // Запоминаем выключенных, чтобы новые провайдеры были включены по умолчанию.
  store.set('providersOff', [...document.querySelectorAll('#providers input:not(:checked)')].map((i) => i.value));
  const box = $('results');
  if (!selected.length) {
    box.replaceChildren(h('div', { class: 'empty' }, 'Выберите хотя бы одного провайдера.'));
    return;
  }
  box.replaceChildren(h('div', { class: 'empty' }, 'Ищем…'));
  showNotice('');
  try {
    const params = new URLSearchParams({
      q: $('q').value.trim(),
      author: $('fAuthor').value.trim(),
      reader: $('fReader').value.trim(),
      lang: $('fLang').value,
      providers: selected.join(','),
    });
    const { results, errors } = await api('/api/search?' + params);
    if (seq !== searchSeq) return;
    if (errors.length) {
      showNotice('Не ответили: ' + errors.map((e) => `${e.provider} (${e.message})`).join('; '));
    }
    box.replaceChildren(
      ...(results.length ? results.map((b) => card(b)) : [h('div', { class: 'empty' }, 'Ничего не найдено.')])
    );
  } catch (e) {
    if (seq !== searchSeq) return;
    box.replaceChildren(h('div', { class: 'empty' }, 'Ошибка поиска: ' + e.message));
  }
}

function renderProviders() {
  const off = store.get('providersOff', []);
  $('providers').replaceChildren(
    ...state.config.providers.map((p) =>
      h(
        'label',
        { class: 'chip' },
        h('input', { type: 'checkbox', value: p.id, checked: !off.includes(p.id),onchange: search }),
        p.name
      )
    )
  );
}

function renderLibrary() {
  const items = Object.values(state.library).sort((a, b) => b.updated - a.updated);
  $('libraryList').replaceChildren(
    ...(items.length
      ? items.map((it) => card(it.book, it.progress ?? 0))
      : [h('div', { class: 'empty' }, 'Здесь появятся книги, которые вы начали слушать или купили.')])
  );
}

function showTab(name) {
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === name);
  $('catalog').hidden = name !== 'catalog';
  $('library').hidden = name !== 'library';
  if (name === 'library') renderLibrary();
}

// --- карточка книги ---------------------------------------------------------
async function openBook(provider, id) {
  const dialog = $('bookDialog');
  const body = $('bookBody');
  body.replaceChildren(h('p', {}, 'Загрузка…'));
  if (!dialog.open) dialog.showModal();
  try {
    const book = await api('/api/book?' + new URLSearchParams({ provider, id }));
    renderBook(book);
  } catch (e) {
    body.replaceChildren(h('p', {}, 'Не удалось загрузить книгу: ' + e.message));
  }
}

function renderBook(book) {
  const saved = state.library[keyOf(book)];
  const playing = state.current && keyOf(state.current.book) === keyOf(book) ? state.current.index : -1;
  const actions = [];

  if (book.locked && book.buyUrl) {
    // Книга покупается на сайте провайдера; после покупки она откроется здесь сама.
    const label = `Купить на сайте за ${fmtPrice(book.price)}`;
    actions.push(
      h('button', { class: 'primary', onclick: () => (nativeBridge ? (location.href = book.buyUrl) : window.open(book.buyUrl, '_blank', 'noopener')) }, label),
      h('button', { onclick: () => openBook(book.provider, book.id) }, 'Я купил — обновить')
    );
  } else if (book.locked) {
    const buy = h('button', { class: 'primary' }, `Купить за ${fmtPrice(book.price)}`);
    buy.onclick = async () => {
      buy.disabled = true;
      buy.textContent = 'Переходим к оплате…';
      try {
        const { url } = await post('/api/checkout', { provider: book.provider, id: book.id });
        location.href = url; // страница оплаты Stripe (или демо-заглушка)
      } catch (e) {
        buy.disabled = false;
        buy.textContent = `Купить за ${fmtPrice(book.price)}`;
        alert('Не удалось начать оплату: ' + e.message);
      }
    };
    actions.push(buy);
  } else if (book.tracks.length) {
    const resume = saved && (saved.track > 0 || saved.time > 5);
    actions.push(
      h(
        'button',
        { class: 'primary', onclick: () => play(book, resume ? saved.track : 0, resume ? saved.time : 0) },
        resume ? 'Продолжить' : 'Слушать'
      )
    );
    actions.push(priceLabel(book));
  }

  $('bookBody').replaceChildren(
    h(
      'div',
      { class: 'book-head' },
      book.cover ? h('img', { src: book.cover, alt: '' }) : null,
      h(
        'div',
        {},
        h('h2', {}, book.title),
        h('div', { class: 'sub' }, book.author),
        h('div', { class: 'sub' }, [providerName(book.provider), fmtLength(book.durationSec)].filter(Boolean).join(' · ')),
        h('div', { class: 'actions' }, actions),
        book.locked &&
          h(
            'p',
            { class: 'pay-note' },
            book.buyUrl
              ? state.config.litres?.login
                ? 'Оплата проходит на сайте ЛитРес под вашим аккаунтом.'
                : 'Войдите в аккаунт ЛитРес (кнопка в шапке), чтобы слушать купленные книги.'
              : state.config.paymentMode === 'demo'
              ? 'Демо-режим: оплата имитируется, карта не нужна.'
              : 'Оплата картой любой страны на защищённой странице Stripe.'
          )
      )
    ),
    book.description ? h('p', { class: 'desc' }, book.description) : null,
    book.tracks.length
      ? h(
          'ol',
          { class: 'tracks' },
          book.tracks.map((t, i) =>
            h(
              'li',
              { class: i === playing ? 'current' : '' },
              h(
                'button',
                { disabled: book.locked, onclick: () => play(book, i, 0) },
                h('span', {}, `${book.locked ? '🔒 ' : ''}${i + 1}. ${t.title}`),
                h('span', { class: 'dur' }, t.durationSec ? fmtTime(t.durationSec) : '')
              )
            )
          )
        )
      : h('p', { class: 'empty' }, 'У этой записи нет аудиофайлов MP3.')
  );
}

// --- плеер ------------------------------------------------------------------
const audio = $('audio');

function play(book, index, time = 0) {
  const track = book.tracks[index];
  if (!track?.url) return;
  state.current = { book, index };
  audio.src = track.url;
  audio.playbackRate = Number($('pSpeed').value);
  if (time > 0) audio.addEventListener('loadedmetadata', () => (audio.currentTime = time), { once: true });
  audio.play().catch(() => {}); // браузер мог запретить автозапуск — останется кнопка ▶

  $('player').hidden = false;
  $('pCover').src = book.cover || '';
  $('pTitle').textContent = book.title;
  $('pTrack').textContent = `${index + 1}/${book.tracks.length} · ${track.title}`;
  remember(book, { track: index, time });
  if ($('bookDialog').open) renderBook(book);

  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: book.author,
      album: book.title,
      artwork: book.cover ? [{ src: book.cover }] : [],
    });
  }
}

function step(delta) {
  const c = state.current;
  if (!c) return;
  const next = c.index + delta;
  if (next >= 0 && next < c.book.tracks.length) play(c.book, next, 0);
}

let lastSave = 0;
function saveProgress(force) {
  const c = state.current;
  if (!c || (!force && Date.now() - lastSave < 5000)) return;
  lastSave = Date.now();
  const frac = audio.duration ? audio.currentTime / audio.duration : 0;
  remember(c.book, {
    track: c.index,
    time: audio.currentTime,
    progress: Math.min(1, (c.index + frac) / c.book.tracks.length),
  });
}

let seeking = false;
audio.addEventListener('timeupdate', () => {
  $('pCur').textContent = fmtTime(audio.currentTime);
  $('pDur').textContent = fmtTime(audio.duration);
  if (!seeking && audio.duration) $('pSeek').value = Math.round((audio.currentTime / audio.duration) * 1000);
  saveProgress(false);
});
audio.addEventListener('play', () => ($('pPlay').textContent = '⏸'));
audio.addEventListener('pause', () => {
  $('pPlay').textContent = '▶';
  saveProgress(true);
});
audio.addEventListener('ended', () => step(1));
audio.addEventListener('error', () => {
  if (state.current) $('pTrack').textContent = 'Не удалось загрузить аудио этой главы';
});

$('pPlay').onclick = () => (audio.paused ? audio.play() : audio.pause());
$('pBack').onclick = () => (audio.currentTime = Math.max(0, audio.currentTime - 15));
$('pFwd').onclick = () => (audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + 30));
$('pPrev').onclick = () => step(-1);
$('pNext').onclick = () => step(1);
$('pSeek').oninput = () => (seeking = true);
$('pSeek').onchange = () => {
  if (audio.duration) audio.currentTime = ($('pSeek').value / 1000) * audio.duration;
  seeking = false;
};
$('pSpeed').value = String(store.get('speed', 1));
$('pSpeed').onchange = () => {
  audio.playbackRate = Number($('pSpeed').value);
  store.set('speed', Number($('pSpeed').value));
};
window.addEventListener('pagehide', () => saveProgress(true));

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('previoustrack', () => step(-1));
  navigator.mediaSession.setActionHandler('nexttrack', () => step(1));
  navigator.mediaSession.setActionHandler('seekbackward', () => $('pBack').onclick());
  navigator.mediaSession.setActionHandler('seekforward', () => $('pFwd').onclick());
}

// --- запуск -----------------------------------------------------------------
$('searchForm').onsubmit = (e) => {
  e.preventDefault();
  search();
};
$('fLang').value = store.get('lang', 'ru');
$('fLang').onchange = () => {
  store.set('lang', $('fLang').value);
  search();
};
for (const t of document.querySelectorAll('.tab')) t.onclick = () => showTab(t.dataset.tab);
$('closeDialog').onclick = () => $('bookDialog').close();
$('bookDialog').addEventListener('click', (e) => {
  if (e.target === $('bookDialog')) $('bookDialog').close(); // клик по фону
});

// Аккаунт ЛитРес: вход, чтобы слушать купленное там.
function renderLitresAccount() {
  const account = state.config.litres;
  $('litresAccount').hidden = !account;
  if (!account) return;
  $('litresAccount').textContent = account.login ? `ЛитРес: ${account.login}` : 'Войти в ЛитРес';
  $('litresForm').hidden = Boolean(account.login);
  $('litresLogged').hidden = !account.login;
  $('litresName').textContent = account.login || '';
}
async function litresRequest(path, body) {
  $('litresError').hidden = true;
  try {
    state.config.litres = await post(path, body);
    $('litresPwd').value = '';
    renderLitresAccount();
    if (state.config.litres.login) $('litresDialog').close();
    search();
  } catch (e) {
    $('litresError').hidden = false;
    $('litresError').textContent = e.message;
  }
}
$('litresAccount').onclick = () => $('litresDialog').showModal();
$('closeLitres').onclick = () => $('litresDialog').close();
$('litresForm').onsubmit = (e) => {
  e.preventDefault();
  litresRequest('/api/litres/login', { login: $('litresLogin').value.trim(), pwd: $('litresPwd').value });
};
$('litresLogout').onclick = () => litresRequest('/api/litres/logout', {});

// Внутри iOS-приложения показываем кнопку настроек адреса сервера.
if (nativeBridge) {
  $('nativeSettings').hidden = false;
  $('nativeSettings').onclick = () => nativeBridge.postMessage('settings');
}

// Возврат со страницы оплаты: ?paid=<id сессии Stripe> | ?bought=<книга> (демо) | ?cancelled=1
async function handleReturn() {
  const params = new URLSearchParams(location.search);
  if (![...params.keys()].length) return;
  history.replaceState(null, '', location.pathname);
  let item = params.get('bought');
  try {
    if (params.get('paid')) {
      const r = await api('/api/checkout/confirm?session_id=' + encodeURIComponent(params.get('paid')));
      item = r.item;
      state.config.owned = r.owned;
    }
  } catch (e) {
    showNotice('Оплата не подтверждена: ' + e.message);
    return;
  }
  if (params.get('cancelled')) showNotice('Оплата отменена.');
  if (item && state.config.owned.includes(item)) {
    const [provider, ...rest] = item.split(':');
    const id = rest.join(':');
    await openBook(provider, id);
    const book = await api('/api/book?' + new URLSearchParams({ provider, id })).catch(() => null);
    if (book) remember(book);
  }
}

(async function init() {
  try {
    state.config = await api('/api/config');
  } catch (e) {
    showNotice('Сервер недоступен: ' + e.message);
    return;
  }
  const mode = state.config.paymentMode;
  if (mode !== 'live') {
    $('payMode').hidden = false;
    $('payMode').textContent = mode === 'demo' ? 'Оплата: демо-режим' : 'Оплата: тестовый режим Stripe';
  }
  renderProviders();
  renderLitresAccount();
  await handleReturn();
  search();
})();
