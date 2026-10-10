import { stripSeason } from '../src/matcher.js';

const $ = (s) => document.querySelector(s);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children.flat().filter((c) => c != null && c !== false));
  return node;
}

async function send(msg) {
  const res = await chrome.runtime.sendMessage(msg);
  if (!res?.ok) throw new Error(res?.error || 'Error desconocido');
  return res;
}

function showError(e) {
  const p = $('#error');
  p.textContent = e ? e.message || String(e) : '';
  p.hidden = !e;
}

// Envuelve un handler de botón: lo desactiva mientras trabaja y muestra el error si falla.
const action = (fn) => async (ev) => {
  const btn = ev?.currentTarget;
  if (btn) btn.disabled = true;
  showError(null);
  try {
    await fn(ev);
  } catch (e) {
    showError(e);
  } finally {
    if (btn) btn.disabled = false;
  }
};

const STATUS = {
  watching: 'Viendo',
  completed: 'Completado',
  on_hold: 'En pausa',
  dropped: 'Abandonado',
  plan_to_watch: 'Pendiente',
};

const checkIcon = () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '3');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = '<path d="M20 6 9 17l-5-5"/>';
  return svg;
};

let tabId;
let windowId;
let data;

async function refresh() {
  data = await send({ type: 'getState', tabId });
  render();
}

// El panel se queda abierto: varias señales seguidas (cambio de estado, historial…) generan un solo refresco.
let refreshTimer;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh().catch(showError), 150);
}

async function followTab(id) {
  if (id === tabId) return;
  tabId = id;
  $('#fixQuery').value = '';
  $('#fixResults').replaceChildren();
  $('#fixResults').hidden = true;
  $('#fix').hidden = true;
  showError(null);
  await refresh();
}

function animeCard(anime, episode, { marked } = {}) {
  const ls = anime.listStatus;
  const watched = marked ? Math.max(episode, ls?.num_episodes_watched || 0) : ls?.num_episodes_watched || 0;
  const pct = anime.numEpisodes ? Math.min(100, (watched / anime.numEpisodes) * 100) : 0;
  const picture = anime.pictureLarge || anime.picture;
  const malUrl = `https://myanimelist.net/anime/${anime.id}`;

  return el(
    'div',
    { class: picture ? 'card hero' : 'card hero no-cover' },
    picture
      ? el(
          'a',
          { class: 'cover-link', href: malUrl, target: '_blank', tabindex: '-1' },
          el('img', { class: 'cover', src: picture, alt: `Portada de ${anime.title}` }),
        )
      : el('div', { class: 'cover empty-cover' }, 'Sin portada'),
    el(
      'div',
      { class: 'card-body' },
      el('a', { class: 'card-title', href: malUrl, target: '_blank' }, anime.title),
      el(
        'div',
        { class: 'ep' },
        el('span', { class: 'ep-num' }, String(episode)),
        el('span', { class: 'ep-of' }, anime.numEpisodes ? `de ${anime.numEpisodes} episodios` : 'episodio'),
      ),
      anime.numEpisodes > 0 && el('div', { class: 'bar' }, el('span', { style: `width: ${pct}%` })),
      el(
        'div',
        { class: 'small' },
        ls ? `${STATUS[ls.status] || ls.status} · ${watched} vistos` : 'No está en tu lista',
      ),
    ),
  );
}

function render() {
  const { state, user, configured, history, sites, threshold } = data;

  // Cuenta
  const account = $('#account');
  account.replaceChildren();
  if (!configured) {
    account.append(
      el('p', { class: 'warn' }, 'Falta configurar tu Client ID de MyAnimeList.'),
      el('button', { class: 'primary', onclick: () => chrome.runtime.openOptionsPage() }, 'Abrir opciones'),
    );
  } else if (!user) {
    account.append(
      el('p', { class: 'muted' }, 'Conecta tu cuenta para que pueda actualizar tu lista.'),
      el(
        'button',
        {
          class: 'primary',
          onclick: action(async () => {
            await send({ type: 'login', tabId });
            await refresh();
          }),
        },
        'Conectar con MyAnimeList',
      ),
    );
  }

  // Episodio actual
  const cur = $('#current');
  cur.replaceChildren();
  if (!state && user) {
    cur.append(el('span', { class: 'label' }, 'Seguir viendo'), el('div', { id: 'continue' }));
    renderContinue();
    if (!continueItems) loadContinue().catch(showError);
    $('#fix').hidden = true;
  } else if (!state) {
    cur.append(
      el('span', { class: 'label' }, 'En esta pestaña'),
      el('div', { class: 'empty' }, 'Abre un episodio en Crunchyroll, JKAnime, AnimeFLV o Prime Video.'),
    );
    $('#fix').hidden = true;
  } else {
    const { info, phase, anime, episode } = state;
    const siteName = sites[info.site] || info.site;
    cur.append(
      el(
        'div',
        { class: 'label-row' },
        el('span', { class: 'label' }, 'En esta pestaña'),
        el('span', { class: 'chip' }, siteName),
      ),
    );
    const fixLink = el('button', { class: 'link', onclick: () => toggleFix(true) }, '¿No es este anime?');

    if (phase === 'resolving') {
      cur.append(el('div', { class: 'empty' }, `Buscando "${info.title}" en MyAnimeList…`));
    } else if (phase === 'matched') {
      const updated = state.marked && state.result === 'updated';
      cur.append(
        animeCard(anime, episode, { marked: updated }),
        updated
          ? el('div', { class: 'ok-line' }, checkIcon(), 'Actualizado en tu lista')
          : el(
              'button',
              {
                class: 'primary',
                disabled: !user,
                onclick: action(async () => {
                  await send({ type: 'markNow', tabId });
                  await refresh();
                }),
              },
              `Marcar ep. ${episode} como visto`,
            ),
        el('div', { class: 'hint-row' }, el('span', {}, `Automático al ${Math.round(threshold * 100)} %`), fixLink),
        // append() escribiría "null"/"undefined" como texto: solo se añade si hay algo que mostrar.
        ...(data.crunchyroll
          ? [
              el(
                'a',
                { class: 'cr-hint', href: data.crUrl || crSearchUrl(anime), target: '_blank' },
                el('span', {}, 'Disponible en ', el('strong', {}, 'Crunchyroll')),
                el('span', { class: 'cr-open' }, 'Abrir'),
              ),
            ]
          : []),
      );
    } else if (phase === 'lowConfidence') {
      cur.append(
        el('p', { class: 'warn' }, `No estoy seguro de que "${info.title}" sea este. ¿Lo confirmas?`),
        animeCard(anime, episode),
        el(
          'div',
          { class: 'actions' },
          el(
            'button',
            {
              class: 'primary',
              onclick: action(async () => {
                await send({ type: 'setMapping', tabId, malId: anime.id, offset: 0 });
                await refresh();
              }),
            },
            'Sí, es este',
          ),
          el('button', { class: 'secondary', onclick: () => toggleFix(true) }, 'Buscar otro'),
        ),
      );
    } else if (phase === 'outOfRange') {
      cur.append(
        el('p', { class: 'warn' }, `El episodio ${info.episode} no encaja con "${anime.title}" (${anime.numEpisodes} episodios).`),
        el('p', { class: 'small' }, 'Elige la temporada correcta o indica cuántos episodios restar.'),
      );
    } else if (phase === 'notFound') {
      cur.append(el('p', { class: 'warn' }, `No encontré "${info.title}" en MyAnimeList.`));
    } else if (phase === 'error') {
      cur.append(el('p', { class: 'error' }, state.error), el('div', {}, fixLink));
    }

    if (!['matched', 'resolving', 'error'].includes(phase) && $('#fix').hidden) toggleFix(true, false);
  }

  // Historial
  const hist = $('#history');
  hist.replaceChildren();
  if (history?.length) {
    hist.append(
      el('span', { class: 'label' }, 'Últimos marcados'),
      el(
        'ul',
        { class: 'list' },
        history.map((h) =>
          el(
            'li',
            {},
            el('a', { href: `https://myanimelist.net/anime/${h.id}`, target: '_blank', title: h.title }, h.title),
            h.done
              ? el('span', { class: 'done' }, `${h.episode}/${h.total} ✓`)
              : el('span', { class: 'count' }, `${h.episode}${h.total ? `/${h.total}` : ''}`),
          ),
        ),
      ),
    );
  }

  // Pie
  const footer = $('#footer');
  footer.hidden = !user;
  footer.replaceChildren();
  if (user) {
    footer.append(
      el('span', {}, 'Conectado como ', el('strong', {}, `@${user.name}`)),
      el(
        'button',
        {
          class: 'link',
          onclick: action(async () => {
            await send({ type: 'logout' });
            await refresh();
          }),
        },
        'Cerrar sesión',
      ),
    );
  }
}

function toggleFix(show, focus = true) {
  const fix = $('#fix');
  fix.hidden = !show;
  if (!show) return;
  const q = $('#fixQuery');
  if (!q.value) q.value = data.state?.info.title || '';
  if (focus) q.focus();
}

function parseMalId(text) {
  const t = text.trim();
  return t.match(/myanimelist\.net\/anime\/(\d+)/)?.[1] || (/^\d+$/.test(t) ? t : null);
}

async function assign(malId) {
  await send({ type: 'setMapping', tabId, malId: Number(malId), offset: Number($('#fixOffset').value) || 0 });
  $('#fixResults').replaceChildren();
  $('#fixResults').hidden = true;
  $('#fix').hidden = true;
  await refresh();
}

$('#fixSearch').addEventListener(
  'click',
  action(async () => {
    const text = $('#fixQuery').value;
    const id = parseMalId(text);
    if (id) return assign(id);
    const { results } = await send({ type: 'search', query: text });
    const list = $('#fixResults');
    list.hidden = false;
    list.replaceChildren(
      ...(results.length
        ? results.map((r) =>
            el(
              'li',
              { onclick: action(() => assign(r.id)) },
              r.picture && el('img', { src: r.picture, alt: '' }),
              el(
                'div',
                {},
                el('div', {}, r.title),
                el('div', { class: 'small' }, `${(r.mediaType || '').toUpperCase()} · ${r.numEpisodes || '?'} eps`),
              ),
            ),
          )
        : [el('li', { class: 'muted' }, 'Sin resultados')]),
    );
  }),
);
$('#fixQuery').addEventListener('keydown', (e) => e.key === 'Enter' && $('#fixSearch').click());

// ---------- Pestañas y "Mi lista"

const FILTERS = [
  ['watching', 'Viendo'],
  ['plan_to_watch', 'Pendientes'],
  ['completed', 'Completados'],
  ['on_hold', 'En pausa'],
  ['dropped', 'Abandonados'],
];
const store = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

let view = store.get('view') === 'list' ? 'list' : 'now';
let listStatus = store.get('listStatus') || 'watching';
let onlyCR = store.get('onlyCR') === '1';
let listItems = null;
let listLoadedFor = null;

function setView(v) {
  view = v;
  store.set('view', v);
  $('#tabNow').setAttribute('aria-selected', String(v === 'now'));
  $('#tabList').setAttribute('aria-selected', String(v === 'list'));
  $('#viewNow').hidden = v !== 'now';
  $('#viewList').hidden = v !== 'list';
  if (v === 'list') loadList().catch(showError);
}

function renderFilters() {
  $('#filters').replaceChildren(
    ...FILTERS.map(([status, name]) =>
      el(
        'button',
        {
          class: 'filter',
          'aria-pressed': String(status === listStatus),
          onclick: () => {
            listStatus = status;
            store.set('listStatus', status);
            renderFilters();
            loadList().catch(showError);
          },
        },
        name,
      ),
    ),
  );
}

async function loadList({ force = false } = {}) {
  const info = $('#listInfo');
  const ul = $('#myList');
  if (!data?.user) {
    info.hidden = false;
    info.textContent = 'Conecta tu cuenta de MyAnimeList para ver tu lista.';
    ul.hidden = true;
    return;
  }
  if (!force && listItems && listLoadedFor === listStatus) return renderList();
  const status = listStatus;
  info.hidden = false;
  info.textContent = 'Cargando tu lista…';
  ul.hidden = true;
  const { items } = await send({ type: 'myList', status });
  if (status !== listStatus) return; // cambiaste de filtro mientras cargaba
  listItems = items;
  listLoadedFor = status;
  renderList();
  fillStreaming(status).catch(showError);
}

// Comprueba poco a poco qué animes de la lista están en Crunchyroll y repinta según llegan.
async function fillStreaming(status) {
  while (listItems && listLoadedFor === status) {
    const ids = listItems.filter((i) => i.crunchyroll === undefined).map((i) => i.id).slice(0, 8);
    if (!ids.length) return;
    const { crunchyroll } = await send({ type: 'streaming', ids });
    if (!listItems || listLoadedFor !== status) return;
    for (const item of listItems) {
      if (!ids.includes(item.id)) continue;
      // Sin respuesta (MAL falló): null para no reintentar en bucle; se volverá a mirar otro día.
      item.crunchyroll = item.id in crunchyroll ? crunchyroll[item.id] : false;
    }
    renderList();
  }
}

// Los enlaces de Crunchyroll que da MAL acaban en la portada. Se abre su buscador con una marca
// (#malauto) para que la extensión elija la serie correcta, entre en ella y la recuerde.
function crSearchUrl({ id, title, enTitle }) {
  const titles = [...new Set([enTitle, title].filter(Boolean))];
  const hash = new URLSearchParams([['malauto', id], ...titles.map((t) => ['t', t])]);
  return `https://www.crunchyroll.com/es/search?q=${encodeURIComponent(stripSeason(titles[0]))}#${hash}`;
}

// Prioridad al abrir: Crunchyroll > la web donde lo estabas viendo > ficha de MAL.
function openAction(item, malUrl) {
  const crUrl =
    (item.site === 'crunchyroll' && item.watchUrl) || item.crUrl || (item.crunchyroll ? crSearchUrl(item) : null);
  if (crUrl) return { url: crUrl, label: 'Crunchyroll', cls: 'btn-sm', where: 'Crunchyroll' };
  if (item.watchUrl) {
    return {
      url: item.watchUrl,
      label: item.nextEpisode ? `Ver ep. ${item.nextEpisode}` : 'Abrir',
      cls: 'btn-sm alt',
      where: data.sites[item.site] || item.site,
    };
  }
  return { url: malUrl, label: 'MAL', cls: 'btn-sm ghost', where: null };
}

// ---------- Seguir viendo: lo que tienes a medias en MAL, en "Ahora viendo" cuando la pestaña no tiene episodio.

const CONTINUE_MAX = 6;
let continueItems = null; // null = sin cargar; se vacía al marcar algo o cambiar de cuenta
let continueLoading = false;

async function loadContinue() {
  if (continueLoading) return;
  continueLoading = true;
  try {
    // Llega ordenada por última actualización en MAL: lo más reciente, primero.
    const { items } = await send({ type: 'myList', status: 'watching' });
    continueItems = items.filter((i) => !i.numEpisodes || i.watched < i.numEpisodes).slice(0, CONTINUE_MAX);
    renderContinue();
    // Dónde se puede ver: solo para los que se enseñan, y una vez.
    const ids = continueItems.filter((i) => i.crunchyroll === undefined).map((i) => i.id);
    if (!ids.length) return;
    const { crunchyroll } = await send({ type: 'streaming', ids });
    for (const item of continueItems || []) {
      if (ids.includes(item.id)) item.crunchyroll = item.id in crunchyroll ? crunchyroll[item.id] : false;
    }
    renderContinue();
  } finally {
    continueLoading = false;
  }
}

function renderContinue() {
  const box = $('#continue');
  if (!box) return;
  if (!continueItems) return box.replaceChildren(el('div', { class: 'empty' }, 'Cargando tu lista…'));
  if (!continueItems.length) {
    return box.replaceChildren(
      el('div', { class: 'empty' }, 'No tienes nada a medias. Abre un episodio en Crunchyroll, JKAnime, AnimeFLV o Prime Video y lo apunto.'),
    );
  }
  box.replaceChildren(
    el(
      'ul',
      { class: 'list mylist' },
      continueItems.map((item) => {
        const pct = item.numEpisodes ? Math.min(100, (item.watched / item.numEpisodes) * 100) : 0;
        const malUrl = `https://myanimelist.net/anime/${item.id}`;
        const open = openAction(item, malUrl);
        return el(
          'li',
          {},
          item.picture ? el('img', { class: 'thumb', src: item.picture, alt: '' }) : el('div', { class: 'thumb' }),
          el(
            'div',
            { class: 'info' },
            el('a', { href: malUrl, target: '_blank', title: `${item.title} en MyAnimeList` }, item.title),
            el(
              'span',
              { class: 'small' },
              `Ep. ${item.watched + 1} · ${item.watched}/${item.numEpisodes || '?'}${open.where ? ` · ${open.where}` : ''}`,
            ),
            item.numEpisodes > 0 && el('div', { class: 'bar' }, el('span', { style: `width: ${pct}%` })),
          ),
          el(
            'a',
            { class: open.cls, href: open.url, target: '_blank', title: open.where ? `Ver en ${open.where}` : 'Abrir en MAL' },
            open.where ? 'Ver ▸' : 'MAL',
          ),
        );
      }),
    ),
  );
}

function renderList() {
  const q = $('#listFilter').value.trim().toLowerCase();
  const items = listItems.filter(
    (i) => (!q || i.title.toLowerCase().includes(q)) && (!onlyCR || i.crunchyroll || i.site === 'crunchyroll'),
  );
  const checking = listItems.some((i) => i.crunchyroll === undefined);
  const info = $('#listInfo');
  const ul = $('#myList');
  info.hidden = false;
  info.textContent =
    (items.length ? `${items.length} ${items.length === 1 ? 'anime' : 'animes'}` : 'Nada por aquí.') +
    (checking ? ' · comprobando Crunchyroll…' : '');
  ul.hidden = !items.length;
  ul.replaceChildren(
    ...items.map((item) => {
      const pct = item.numEpisodes ? Math.min(100, (item.watched / item.numEpisodes) * 100) : 0;
      const malUrl = `https://myanimelist.net/anime/${item.id}`;
      const open = openAction(item, malUrl);
      return el(
        'li',
        {},
        item.picture ? el('img', { class: 'thumb', src: item.picture, alt: '' }) : el('div', { class: 'thumb' }),
        el(
          'div',
          { class: 'info' },
          el('a', { href: malUrl, target: '_blank', title: `${item.title} en MyAnimeList` }, item.title),
          el(
            'span',
            { class: 'small' },
            `${item.watched}/${item.numEpisodes || '?'}${open.where ? ` · ${open.where}` : ''}`,
          ),
          item.numEpisodes > 0 && el('div', { class: 'bar' }, el('span', { style: `width: ${pct}%` })),
        ),
        el('a', { class: open.cls, href: open.url, target: '_blank' }, open.label),
      );
    }),
  );
}

$('#tabNow').addEventListener('click', () => setView('now'));
$('#tabList').addEventListener('click', () => setView('list'));
$('#listFilter').addEventListener('input', () => listItems && renderList());
$('#onlyCR').setAttribute('aria-pressed', String(onlyCR));
$('#onlyCR').addEventListener('click', () => {
  onlyCR = !onlyCR;
  store.set('onlyCR', onlyCR ? '1' : '0');
  $('#onlyCR').setAttribute('aria-pressed', String(onlyCR));
  if (listItems) renderList();
});
$('#openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());

// Dos formas de abrirse: desde el icono de la extensión (popup, va con la pestaña activa) o desde la mascota,
// metido en la propia web (iframe, se queda con su pestaña).
const embedded = window.top !== window;
document.documentElement.classList.toggle('embedded', embedded);
if (embedded) {
  // Esc cierra el panel aunque el foco esté dentro del iframe.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') parent.postMessage({ malAuto: 'closePanel' }, '*');
  });
} else {
  chrome.tabs.onActivated.addListener((info) => {
    if (info.windowId === windowId) followTab(info.tabId).catch(showError);
  });
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && `tab:${tabId}` in changes) scheduleRefresh();
  if (area === 'local' && ('history' in changes || 'auth' in changes)) {
    scheduleRefresh();
    // Se ha marcado algo o cambiaste de cuenta: la lista guardada ya no vale.
    listItems = null;
    continueItems = null;
    if (view === 'list') setTimeout(() => loadList().catch(showError), 300);
  }
  if (area === 'sync' && 'settings' in changes) scheduleRefresh();
  if (area === 'local' && 'platforms' in changes && view === 'now') scheduleRefresh();
});

(async () => {
  windowId = (await chrome.windows.getCurrent()).id;
  const [tab] = embedded ? [await chrome.tabs.getCurrent()] : await chrome.tabs.query({ active: true, windowId });
  renderFilters();
  await followTab(tab?.id);
  setView(view);
})().catch(showError);
