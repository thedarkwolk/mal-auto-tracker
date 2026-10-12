import { stripSeason } from '../src/matcher.js';

const $ = (s) => document.querySelector(s);

// Los enlaces solo a webs (http o https): muchos vienen de fuera (plataformas, mangas…) y no deben poder llevar un
// "javascript:" u otro esquema raro, aunque la política de seguridad del panel ya los bloquearía.
const webUrl = (url) => (/^https?:\/\//i.test(String(url)) ? url : null);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'href') webUrl(v) && node.setAttribute(k, v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  return fill(node, ...children);
}

// Añade hijos a un nodo saltándose los vacíos: con append()/replaceChildren() a secas, un `cond && el(...)` que no
// se cumple saldría escrito como "false".
function fill(node, ...children) {
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

// Siguiente episodio (AniList) del anime de la pestaña, para decir cuándo sale. Se pide una vez por anime y, si
// llega con fecha, se repinta.
let tabAiring = { id: null, airing: null };
function loadTabAiring(id) {
  if (tabAiring.id === id) return;
  tabAiring = { id, airing: null };
  send({ type: 'airing', ids: [id] })
    .then(({ airing }) => {
      if (tabAiring.id !== id) return;
      tabAiring.airing = airing[id] || null;
      if (tabAiring.airing?.next) render();
    })
    .catch(() => {});
}

// El anime de la pestaña, compacto para que el botón de marcar quede a la vista: portada, título, el episodio en
// grande, tu progreso y cuándo sale el siguiente. Entera abre su ficha.
function animeCard(anime, episode, { marked } = {}) {
  loadTabAiring(anime.id);
  const ls = anime.listStatus;
  const watched = marked ? Math.max(episode, ls?.num_episodes_watched || 0) : ls?.num_episodes_watched || 0;
  const pct = anime.numEpisodes ? Math.min(100, (watched / anime.numEpisodes) * 100) : 0;
  const picture = anime.pictureLarge || anime.picture;
  const next = tabAiring.id === anime.id ? tabAiring.airing?.next : null;

  return el(
    'a',
    { class: 'now-card', ...toDetail(anime.id), title: `Ficha de ${anime.title}` },
    picture ? el('img', { class: 'now-cover', src: picture, alt: '' }) : el('span', { class: 'now-cover' }),
    el(
      'span',
      { class: 'now-info' },
      el('span', { class: 'now-title' }, anime.title),
      anime.enTitle && anime.enTitle !== anime.title && el('span', { class: 'd-alt' }, anime.enTitle),
      // "Ep. 2 de 12" (sin total conocido, solo "Ep. 2")
      el(
        'span',
        { class: 'ep' },
        el('span', { class: 'ep-of' }, 'Ep.'),
        el('span', { class: 'ep-num' }, String(episode)),
        anime.numEpisodes > 0 && el('span', { class: 'ep-of' }, `de ${anime.numEpisodes}`),
      ),
      anime.numEpisodes > 0 && el('span', { class: 'bar' }, el('span', { style: `width: ${pct}%` })),
      el(
        'span',
        { class: 'small' },
        ls ? `${STATUS[ls.status] || ls.status} · ${watched} ${watched === 1 ? 'visto' : 'vistos'}` : 'No está en tu lista',
      ),
      next && el('span', { class: 'small now-next' }, `El ep. ${next.episode} sale ${airDate(next.at)}`),
    ),
  );
}

// Episodio anterior y siguiente en la web de la pestaña: los da su content script (episodeNav). Se piden una vez
// por episodio y, si llegan, se repinta. Recién cargada, la web puede no tenerlos aún (Crunchyroll los pinta un
// poco después): se reintenta un par de veces.
let tabNav = { key: null, nav: null };
function loadTabNav(key, tries = 3) {
  if (tabNav.key === key && tries === 3) return;
  tabNav = { key, nav: null };
  chrome.tabs
    .sendMessage(tabId, { type: 'episodeNav' }, { frameId: 0 })
    .catch(() => null) // web sin script (o aún cargando)
    .then((nav) => {
      if (tabNav.key !== key) return;
      if (nav?.prev || nav?.next) {
        tabNav.nav = nav;
        render();
      } else if (tries > 1) setTimeout(() => tabNav.key === key && loadTabNav(key, tries - 1), 2000);
    });
}

// ‹ Ep. 1 · Ep. 3 ›: lleva la pestaña al episodio anterior o al siguiente. El siguiente se desactiva pasado el
// último y mientras no se haya emitido (la tarjeta ya dice cuándo sale).
function episodeNav(state) {
  loadTabNav(`${tabId}:${state.epKey}`);
  const nav = tabNav.nav;
  if (!nav?.prev && !nav?.next) return null;
  const { anime, episode } = state;
  const airing = tabAiring.id === anime.id ? tabAiring.airing : null;
  const isLast = anime.numEpisodes > 0 && episode >= anime.numEpisodes;
  const notAired = airing?.aired != null && episode >= airing.aired;
  const go = (url) => () => chrome.tabs.update(tabId, { url }).catch(showError);
  return el(
    'div',
    { class: 'ep-nav' },
    el('button', { class: 'secondary', disabled: !nav.prev, onclick: go(nav.prev) }, episode > 1 ? `‹ Ep. ${episode - 1}` : '‹ Anterior'),
    el(
      'button',
      {
        class: 'secondary',
        disabled: !nav.next || isLast || notAired,
        title: isLast ? 'Es el último episodio' : notAired ? 'Aún no se ha emitido' : false,
        onclick: go(nav.next),
      },
      `Ep. ${episode + 1} ›`,
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
      fill(
        cur,
        animeCard(anime, episode, { marked: updated }),
        episodeNav(state),
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
        data.crunchyroll &&
          el(
            'a',
            { class: 'cr-hint', href: crPage({ ...anime, crUrl: data.crUrl, crLink: data.crLink }), target: '_blank' },
            el('span', { class: 'cr-hint-text' }, crIcon(), 'Disponible en ', el('strong', {}, 'Crunchyroll')),
            el('span', { class: 'cr-open' }, 'Abrir'),
          ),
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
            el('a', { ...toDetail(h.id), title: h.title }, h.title),
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

const VIEWS = ['now', 'list', 'season'];
let view = VIEWS.includes(store.get('view')) ? store.get('view') : 'now';
let listStatus = store.get('listStatus') || 'watching';
let onlyCR = store.get('onlyCR') === '1';
let listItems = null;
let listLoadedFor = null;

function setView(v) {
  view = v;
  store.set('view', v);
  $('#tabNow').setAttribute('aria-selected', String(v === 'now'));
  $('#tabList').setAttribute('aria-selected', String(v === 'list'));
  $('#tabSeason').setAttribute('aria-selected', String(v === 'season'));
  $('#viewNow').hidden = v !== 'now';
  $('#viewList').hidden = v !== 'list';
  $('#viewSeason').hidden = v !== 'season';
  // Ir a una pestaña cierra la ficha que hubiera abierta.
  detailStack = [];
  $('#viewDetail').hidden = true;
  // Los filtros de cada pestaña van en la barra de abajo (la franja del bot)
  $('#listBar').hidden = v !== 'list';
  $('#seasonBar').hidden = v !== 'season';
  $('#filterBar').classList.toggle('no-filters', v === 'now');
  if (v === 'list') loadList().catch(showError);
  if (v === 'season') loadSeason().catch(showError);
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
    const res = await send({ type: 'streaming', ids });
    if (!listItems || listLoadedFor !== status) return;
    applyStreaming(listItems, ids, res);
    renderList();
  }
}

// Pasa a los animes pedidos lo que respondió 'streaming': si están en Crunchyroll y, de los recién comprobados,
// el enlace a su serie o a un episodio.
function applyStreaming(items, ids, { crunchyroll, links }) {
  for (const item of items) {
    if (!ids.includes(item.id)) continue;
    // Sin respuesta (MAL falló): false para no reintentar en bucle; se volverá a mirar otro día.
    item.crunchyroll = item.id in crunchyroll ? crunchyroll[item.id] : false;
    if (links[item.id]) Object.assign(item, links[item.id]);
  }
}

// Logo de Crunchyroll (Simple Icons, CC0) en su naranja, para marcar los animes que puedes ver allí.
const CR_LOGO =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M2.933 13.467a10.55 10.55 0 1 1 21.067-.8V12c0-6.627-5.373-12-12-12S0 5.373 0 12s5.373 12 12 12h.8a10.617 10.617 0 0 1-9.867-10.533zM19.2 14a3.85 3.85 0 0 1-1.333-7.467A7.89 7.89 0 0 0 14 5.6a8.4 8.4 0 1 0 8.4 8.4 6.492 6.492 0 0 0-.133-1.6A3.415 3.415 0 0 1 19.2 14z"/></svg>';

// Botón de filtro "solo Crunchyroll": con el logo delante y su explicación.
function crToggle(button) {
  button.classList.add('cr-toggle');
  button.title = 'Solo los que están en Crunchyroll';
  button.prepend(crIcon());
  return button;
}

function crIcon(cls = 'cr-icon') {
  const icon = el('span', { class: cls, title: 'Disponible en Crunchyroll' });
  icon.innerHTML = CR_LOGO;
  return icon;
}

// Está en Crunchyroll si lo ves allí, si ya se conoce su serie o si MAL lo da como disponible en tu país.
const onCrunchyroll = (item) => item.site === 'crunchyroll' || !!item.crUrl || !!item.crunchyroll;

// Portada con el logo de Crunchyroll en la esquina cuando el anime está allí.
function withCrBadge(item, coverNode) {
  return onCrunchyroll(item) ? el('span', { class: 'cover-wrap' }, coverNode, crIcon('cr-badge')) : coverNode;
}

// Texto para el buscador de Crunchyroll: sin temporada ni signos (con comillas o comas no encuentra nada:
// '"Tis Time for "Torture," Princess' no da resultados y sin ellos sí).
const crQuery = (t) =>
  stripSeason(t)
    .replace(/["“”'’`´,.:;!?()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// Sin enlace directo, se abre el buscador de Crunchyroll con una marca (#malauto) para que la extensión elija
// la serie correcta, entre en ella y la recuerde. Si la primera búsqueda no la encuentra, prueba las siguientes
// (q): el título original y las cuatro primeras palabras del inglés, por si Crunchyroll lo acorta
// ("Rascal Does Not Dream" para "Rascal Does Not Dream of Santa Claus").
function crSearchUrl({ id, title, enTitle }) {
  const titles = [...new Set([enTitle, title].filter(Boolean))];
  const first = crQuery(titles[0]);
  const candidates = [first, ...titles.slice(1).map(crQuery), first.split(' ').slice(0, 4).join(' ')];
  const queries = [...new Map(candidates.map((q) => [q.toLowerCase(), q])).values()]; // sin repetir por mayúsculas
  const hash = new URLSearchParams([
    ['malauto', id],
    ...titles.map((t) => ['t', t]),
    ...queries.slice(1).filter(Boolean).map((q) => ['q', q]),
  ]);
  return `https://www.crunchyroll.com/es/search?q=${encodeURIComponent(first)}#${hash}`;
}

// Dónde abrir un anime en Crunchyroll: su serie si ya se conoce; el enlace que da MAL a un episodio (la extensión
// salta desde ahí a la serie y la recuerda); o, si no hay nada, el buscador.
function crPage(item) {
  if (item.crUrl) return item.crUrl;
  if (item.crLink) return `${item.crLink}#${new URLSearchParams([['malauto', item.id]])}`;
  return crSearchUrl(item);
}

// Dónde abrir un anime, por prioridad: Crunchyroll > la web donde lo estabas viendo > ficha de MAL (where: null).
function openAction(item, malUrl) {
  const crUrl =
    (item.site === 'crunchyroll' && item.watchUrl) || item.crUrl || (item.crunchyroll ? crPage(item) : null);
  if (crUrl) return { url: crUrl, where: 'Crunchyroll' };
  if (item.watchUrl) return { url: item.watchUrl, where: data.sites[item.site] || item.site };
  return { url: malUrl, where: null };
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
    // Solo para los que se enseñan: qué episodios han salido (AniList) y dónde se pueden ver (una vez).
    const ids = continueItems.map((i) => i.id);
    const unchecked = continueItems.filter((i) => i.crunchyroll === undefined).map((i) => i.id);
    await Promise.all([
      send({ type: 'airing', ids }).then(({ airing }) => {
        for (const item of continueItems || []) item.airing = airing[item.id] || null;
        renderContinue();
      }),
      unchecked.length &&
        send({ type: 'streaming', ids: unchecked }).then((res) => {
          applyStreaming(continueItems || [], unchecked, res);
          renderContinue();
        }),
    ]);
  } finally {
    continueLoading = false;
  }
}

// Al día: has visto todo lo emitido y el siguiente aún no ha salido (sin datos de AniList, se da por no).
const upToDate = (item) => item.airing?.aired != null && item.watched >= item.airing.aired;

// "hoy a las 16:00", "mañana a las 16:00", "vie 16 a las 16:00" o, si falta más de una semana, "3 ene a las 15:16".
function airDate(ms) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 864e5);
  const day =
    days === 0
      ? 'hoy'
      : days === 1
        ? 'mañana'
        : days < 7
          ? `${d.toLocaleDateString('es-ES', { weekday: 'short' })} ${d.getDate()}`
          : d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
  return `${day} a las ${time}`;
}

const PLAY_ICON = '<svg width="12" height="14" viewBox="0 0 12 14" aria-hidden="true"><path d="M1 1.2v11.6a.8.8 0 0 0 1.2.7l9.3-5.8a.8.8 0 0 0 0-1.4L2.2.5A.8.8 0 0 0 1 1.2z" fill="currentColor"/></svg>';

function cover(item) {
  return withCrBadge(
    item,
    item.picture
      ? el('img', { class: 'c-cover', src: item.picture, alt: '', loading: 'lazy' })
      : el('span', { class: 'c-cover' }),
  );
}

// Tarjeta con dos destinos: la tarjeta abre la ficha del anime y el botón de play, dónde verlo el episodio `ep`. Sin
// dónde verlo, el botón es el de MAL. `side` sustituye al botón (el ✓ de los completados).
function playRow(item, ep, info, side) {
  const malUrl = `https://myanimelist.net/anime/${item.id}`;
  if (!side) {
    const open = openAction(item, malUrl);
    side = el(
      'a',
      {
        class: `c-play${open.where ? '' : ' mal'}`,
        href: open.url,
        target: '_blank',
        title: open.where ? `Ver el episodio ${ep} en ${open.where}` : `${item.title} en MyAnimeList`,
      },
      open.where ? '' : 'MAL',
    );
    if (open.where) side.innerHTML = PLAY_ICON;
  }
  return el(
    'li',
    {},
    el(
      'div',
      { class: 'c-row split' },
      el('a', { class: 'c-link', ...toDetail(item.id), title: `Ficha de ${item.title}` }, cover(item), info),
      side,
    ),
  );
}

// Una fila de "para ver": el play lleva al siguiente episodio.
function continueRow(item) {
  const next = item.watched + 1;
  const pct = item.numEpisodes ? Math.min(100, (item.watched / item.numEpisodes) * 100) : 0;
  const aired = item.airing?.aired;
  const pending = aired != null ? aired - item.watched : null;
  return playRow(
    item,
    next,
    // Dónde se abre lo dicen el logo de Crunchyroll y el título del play; abajo, solo el episodio.
    el(
      'span',
      { class: 'c-info' },
      el('span', { class: 'c-title' }, item.title),
      el('span', { class: 'c-meta' }, el('strong', {}, `Ep. ${next}`), el('span', {}, `de ${item.numEpisodes || '?'}`)),
      // [6 por ver][━━━━──────] : los episodios emitidos sin ver, delante de la barra de progreso
      (pending > 1 || item.numEpisodes > 0) &&
        el(
          'span',
          { class: 'c-progress' },
          pending > 1 && el('span', { class: 'c-pending', title: `${pending} episodios emitidos sin ver` }, `${pending} por ver`),
          item.numEpisodes > 0 && el('span', { class: 'bar' }, el('span', { style: `width: ${pct}%` })),
        ),
    ),
  );
}

// Una fila de "al día": compacta, con cuándo sale el siguiente; enlaza a la ficha del anime.
function upcomingRow(item) {
  const next = item.airing?.next;
  return el(
    'li',
    {},
    el(
      'a',
      { class: 'c-row', ...toDetail(item.id), title: `Ficha de ${item.title}` },
      cover(item),
      el(
        'span',
        { class: 'c-info' },
        el('span', { class: 'c-title' }, item.title),
        el(
          'span',
          { class: 'c-meta' },
          next ? `Ep. ${next.episode} ${airDate(next.at)}` : `${item.watched}/${item.numEpisodes || '?'} · sin fecha para el siguiente`,
        ),
      ),
    ),
  );
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
  const toWatch = continueItems.filter((i) => !upToDate(i));
  // Al día: primero lo que sale antes; sin fecha, al final.
  const caughtUp = continueItems
    .filter(upToDate)
    .sort((a, b) => (a.airing.next?.at ?? Infinity) - (b.airing.next?.at ?? Infinity));
  box.replaceChildren();
  fill(
    box,
    toWatch.length
      ? el('ul', { class: 'continue' }, toWatch.map(continueRow))
      : el('div', { class: 'empty' }, 'Vas al día con todo lo que estás viendo.'),
    caughtUp.length > 0 && el('span', { class: 'label' }, 'Al día · próximos episodios'),
    caughtUp.length > 0 && el('ul', { class: 'continue upcoming' }, caughtUp.map(upcomingRow)),
  );
}

// Una tarjeta de Mi lista, como las de "Seguir viendo". Los completados no tienen nada que ver: llevan un ✓ en vez
// del play.
function listRow(item) {
  const pct = item.numEpisodes ? Math.min(100, (item.watched / item.numEpisodes) * 100) : 0;
  return playRow(
    item,
    item.watched + 1,
    el(
      'span',
      { class: 'c-info' },
      el('span', { class: 'c-title' }, item.title),
      el(
        'span',
        { class: 'c-meta' },
        el('strong', {}, String(item.watched)),
        el('span', {}, `de ${item.numEpisodes || '?'}`),
        item.score > 0 && el('span', { class: 'c-score', title: 'Tu nota en MAL' }, `★ ${item.score}`),
      ),
      item.numEpisodes > 0 && el('span', { class: 'c-progress' }, el('span', { class: 'bar' }, el('span', { style: `width: ${pct}%` }))),
    ),
    item.status === 'completed' && el('span', { class: 'c-play done', title: 'Completado' }, '✓'),
  );
}

function renderList() {
  const q = $('#listFilter').value.trim().toLowerCase();
  const items = listItems.filter(
    (i) => (!q || i.title.toLowerCase().includes(q)) && (!onlyCR || onCrunchyroll(i)),
  );
  const checking = listItems.some((i) => i.crunchyroll === undefined);
  const info = $('#listInfo');
  const ul = $('#myList');
  info.hidden = false;
  info.textContent =
    (items.length ? `${items.length} ${items.length === 1 ? 'anime' : 'animes'}` : 'Nada por aquí.') +
    (checking ? ' · comprobando Crunchyroll…' : '');
  ul.hidden = !items.length;
  ul.replaceChildren(...items.map(listRow));
}

// ---------- Temporada: los estrenos de una temporada en MAL, con tu estado en la lista y dónde verlos.

const SEASONS = ['winter', 'spring', 'summer', 'fall'];
const SEASON_NAMES = { winter: 'Invierno', spring: 'Primavera', summer: 'Verano', fall: 'Otoño' };
const SEASON_FILTERS = [
  ['all', 'Todos'],
  ['new', 'Sin añadir'],
  ['mine', 'En mi lista'],
];
// Temporada de MAL de una fecha: invierno = enero-marzo, primavera = abril-junio, verano = julio-septiembre…
const seasonOf = (d = new Date()) => ({ year: d.getFullYear(), season: SEASONS[Math.floor(d.getMonth() / 3)] });
const seasonKey = ({ year, season }) => `${season}-${year}`;

let seasonAt = seasonOf();
let seasonFilter = SEASON_FILTERS.some(([k]) => k === store.get('seasonFilter')) ? store.get('seasonFilter') : 'all';
let seasonOnlyCR = store.get('seasonOnlyCR') === '1';
let seasonItems = null;
let seasonLoadedFor = null;

function moveSeason(step) {
  const i = SEASONS.indexOf(seasonAt.season) + step;
  seasonAt = { year: seasonAt.year + Math.floor(i / 4), season: SEASONS[(i + 4) % 4] };
  loadSeason().catch(showError);
}

function renderSeasonFilters() {
  const chip = (label, pressed, onclick) =>
    el('button', { class: 'filter', 'aria-pressed': String(pressed), onclick }, label);
  $('#seasonFilters').replaceChildren(
    ...SEASON_FILTERS.map(([key, name]) =>
      chip(name, key === seasonFilter, () => {
        seasonFilter = key;
        store.set('seasonFilter', key);
        renderSeasonFilters();
        if (seasonItems) renderSeason();
      }),
    ),
    crToggle(
      chip('Crunchyroll', seasonOnlyCR, () => {
        seasonOnlyCR = !seasonOnlyCR;
        store.set('seasonOnlyCR', seasonOnlyCR ? '1' : '0');
        renderSeasonFilters();
        if (seasonItems) renderSeason();
      }),
    ),
  );
}

async function loadSeason({ force = false } = {}) {
  const key = seasonKey(seasonAt);
  $('#seasonName').textContent = `${SEASON_NAMES[seasonAt.season]} ${seasonAt.year}`;
  renderSeasonFilters();
  if (!force && seasonItems && seasonLoadedFor === key) return renderSeason();
  const info = $('#seasonInfo');
  info.hidden = false;
  info.textContent = 'Cargando la temporada…';
  $('#seasonList').hidden = true;
  const { items } = await send({ type: 'season', year: seasonAt.year, season: seasonAt.season });
  if (seasonKey(seasonAt) !== key) return; // cambiaste de temporada mientras cargaba
  seasonItems = items;
  seasonLoadedFor = key;
  renderSeason();
  // Después, sin bloquear: el siguiente episodio de los que se emiten (AniList) y si están en Crunchyroll.
  const onAir = items.filter((i) => i.onAir).map((i) => i.id);
  if (onAir.length) {
    send({ type: 'airing', ids: onAir })
      .then(({ airing }) => {
        if (seasonLoadedFor !== key) return;
        for (const item of seasonItems) item.next = airing[item.id]?.next || null;
        renderSeason();
      })
      .catch(() => {});
  }
  fillSeasonStreaming(key).catch(showError);
}

// Como en Mi lista: comprueba poco a poco qué estrenos están en Crunchyroll y repinta según llegan.
async function fillSeasonStreaming(key) {
  while (seasonItems && seasonLoadedFor === key) {
    const ids = seasonItems.filter((i) => i.crunchyroll === undefined).map((i) => i.id).slice(0, 8);
    if (!ids.length) return;
    const res = await send({ type: 'streaming', ids });
    if (!seasonItems || seasonLoadedFor !== key) return;
    applyStreaming(seasonItems, ids, res);
    renderSeason();
  }
}

// Lo que va a la derecha: tu estado si ya lo tienes en la lista; si no, un botón para apuntarlo como pendiente.
function seasonSide(item) {
  if (item.listStatus) {
    const text =
      item.listStatus === 'watching'
        ? `Viendo ${item.watched}/${item.numEpisodes || '?'}`
        : STATUS[item.listStatus] || item.listStatus;
    return el('span', { class: 'chip' }, text);
  }
  if (!data?.user) return null;
  return el(
    'button',
    {
      class: 's-add',
      title: 'Añadir a tu lista de MAL como pendiente',
      onclick: action(async () => {
        await send({ type: 'addToList', id: item.id, status: 'plan_to_watch' });
        item.listStatus = 'plan_to_watch';
        listItems = null; // Mi lista ha cambiado
        renderSeason();
      }),
    },
    '+ Pendiente',
  );
}

const compact = new Intl.NumberFormat('es-ES', { notation: 'compact', maximumFractionDigits: 1 });

// Fecha de estreno de MAL ("2026-10-03", o solo "2026-10" si aún no hay día) → "Empieza el 3 oct" / "Empieza en oct".
function startsOn(date) {
  const [y, m, d] = date.split('-').map(Number);
  if (!m) return `Empieza en ${y}`;
  const month = new Date(y, m - 1, d || 1).toLocaleDateString('es-ES', { month: 'short' }).replace('.', '');
  return d ? `Empieza el ${d} ${month}` : `Empieza en ${month}`;
}

// Orden de la lista: el de MAL (popularidad), por nota o por lo que sale antes (episodio o estreno).
const SEASON_SORTS = {
  popular: null,
  score: (a, b) => (b.mean ?? -1) - (a.mean ?? -1),
  next: (a, b) => nextAt(a) - nextAt(b),
};
function nextAt(item) {
  if (item.next) return item.next.at;
  if (item.startDate) return new Date(item.startDate).getTime();
  return Infinity;
}
let seasonSort = SEASON_SORTS[store.get('seasonSort')] !== undefined ? store.get('seasonSort') : 'popular';

function seasonRow(item) {
  const meta = [
    item.mediaType === 'ona' ? 'ONA' : 'TV',
    item.numEpisodes ? `${item.numEpisodes} eps` : null,
    item.mean ? `★ ${item.mean.toFixed(2).replace('.', ',')}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  // Debajo, cada uno en su línea: cuándo sale el siguiente episodio (o cuándo se estrena) y cuánta gente lo sigue.
  const when = item.next ? `Ep. ${item.next.episode} ${airDate(item.next.at)}` : item.startDate ? startsOn(item.startDate) : null;
  const members = item.members ? `${compact.format(item.members)} miembros` : null;
  return el(
    'li',
    { class: 's-row' },
    el(
      'a',
      { class: 's-link', ...toDetail(item.id), title: `Ficha de ${item.title}` },
      cover(item),
      el(
        'span',
        { class: 'c-info' },
        el('span', { class: 'c-title' }, item.title),
        el('span', { class: 'c-meta' }, meta),
        when && el('span', { class: 'c-meta c-when' }, when),
        members && el('span', { class: 'c-meta' }, members),
      ),
    ),
    seasonSide(item),
  );
}

function renderSeason() {
  const items = seasonItems.filter(
    (i) =>
      (seasonFilter === 'all' || (seasonFilter === 'new' ? !i.listStatus : !!i.listStatus)) &&
      (!seasonOnlyCR || onCrunchyroll(i)),
  );
  if (SEASON_SORTS[seasonSort]) items.sort(SEASON_SORTS[seasonSort]);
  const checking = seasonItems.some((i) => i.crunchyroll === undefined);
  const info = $('#seasonInfo');
  info.hidden = false;
  info.textContent =
    (items.length ? `${items.length} ${items.length === 1 ? 'estreno' : 'estrenos'}` : 'Nada por aquí.') +
    (checking ? ' · comprobando Crunchyroll…' : '');
  const ul = $('#seasonList');
  ul.hidden = !items.length;
  ul.replaceChildren(...items.map(seasonRow));
}

// ---------- Ficha de un anime: se abre desde cualquier tarjeta y tapa la pestaña en la que estabas. "Volver"
// regresa a ella, o a la ficha anterior si has ido saltando por los relacionados.

const MEDIA_TYPES = {
  tv: 'TV',
  tv_short: 'TV corto',
  ona: 'ONA',
  ova: 'OVA',
  movie: 'Película',
  special: 'Especial',
  tv_special: 'Especial de TV',
  music: 'Música',
  pv: 'PV',
  cm: 'Anuncio',
};
const AIR_STATUS = { currently_airing: 'En emisión', finished_airing: 'Finalizado', not_yet_aired: 'Por estrenar' };
const SOURCES = {
  original: 'Original',
  manga: 'Manga',
  web_manga: 'Manga web',
  '4_koma_manga': 'Manga 4-koma',
  light_novel: 'Novela ligera',
  novel: 'Novela',
  web_novel: 'Novela web',
  visual_novel: 'Novela visual',
  game: 'Videojuego',
  card_game: 'Juego de cartas',
  book: 'Libro',
  picture_book: 'Libro ilustrado',
  music: 'Música',
  radio: 'Radio',
  mixed_media: 'Multimedia',
};
// Relación (de MAL) de otro anime con este. En este orden salen en "Más de la serie"; la precuela y la secuela van
// aparte, en sus tarjetas.
const RELATIONS = {
  prequel: 'Precuela',
  sequel: 'Secuela',
  parent_story: 'Historia principal',
  full_story: 'Historia completa',
  side_story: 'Historia paralela',
  summary: 'Resumen',
  alternative_version: 'Otra versión',
  alternative_setting: 'Otro universo',
  spin_off: 'Spin-off',
  character: 'Mismos personajes',
  other: 'Otro',
};
const RELATION_ORDER = Object.keys(RELATIONS);
// Estado de un relacionado (de AniList). Lo terminado no se dice: es lo normal.
const RELATED_STATUS = { RELEASING: 'En emisión', NOT_YET_RELEASED: 'Por estrenar', HIATUS: 'En pausa', CANCELLED: 'Cancelado' };
const MANGA_STATUS = { RELEASING: 'En publicación', NOT_YET_RELEASED: 'Por publicar', HIATUS: 'En pausa', CANCELLED: 'Cancelado' };
const MANGA_FORMATS = { MANGA: 'Manga', NOVEL: 'Novela', ONE_SHOT: 'One-shot' };
// Relación de un manga con el anime cuando no es la de siempre (en el que se basa o el que lo adapta).
const MANGA_RELATIONS = {
  PREQUEL: 'Precuela',
  SEQUEL: 'Secuela',
  SIDE_STORY: 'Historia paralela',
  ALTERNATIVE: 'Otra versión',
  SPIN_OFF: 'Spin-off',
  CHARACTER: 'Mismos personajes',
  OTHER: 'Otro',
};

let detailStack = []; // ids de las fichas abiertas; la última es la que se ve
let detailScroll = 0; // dónde estabas en la pestaña, para volver ahí
let detailAnime = null;

// Atributos de un enlace a la ficha: un clic la abre en el panel; con Ctrl/Cmd/Mayús o con la rueda, la de MAL en
// otra pestaña.
function toDetail(id) {
  return {
    href: `https://myanimelist.net/anime/${id}`,
    target: '_blank',
    onclick: (e) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey) return;
      e.preventDefault();
      openDetail(id);
    },
  };
}

function openDetail(id) {
  if (!detailStack.length) detailScroll = scrollY;
  detailStack.push(id);
  showDetail();
}

function closeDetail() {
  detailStack.pop();
  if (detailStack.length) return showDetail();
  setView(view);
  if (view === 'now') render(); // por si cambiaste algo de tu lista: Seguir viendo se recarga
  scrollTo(0, detailScroll);
}

const detailTop = (id) =>
  el(
    'div',
    { class: 'd-top' },
    el('button', { class: 'd-back', onclick: closeDetail }, '‹ Volver'),
    el('a', { class: 'd-mal', href: `https://myanimelist.net/anime/${id}`, target: '_blank' }, 'Ver en MyAnimeList ↗'),
  );

async function showDetail() {
  const id = detailStack.at(-1);
  showError(null);
  for (const s of ['#viewNow', '#viewList', '#viewSeason', '#listBar', '#seasonBar']) $(s).hidden = true;
  $('#filterBar').classList.add('no-filters');
  $('#viewDetail').hidden = false;
  scrollTo(0, 0);
  const box = $('#detail');
  box.replaceChildren(detailTop(id), el('div', { class: 'empty' }, 'Cargando ficha…'));
  try {
    let { anime } = await send({ type: 'anime', id });
    if (detailStack.at(-1) !== id) return; // has cambiado de ficha mientras cargaba
    detailAnime = anime;
    renderDetail();
    // Aún no se sabe dónde se puede ver: se comprueba y se vuelve a pintar (la ficha ya está en caché).
    if (anime.crunchyroll === undefined) {
      await send({ type: 'streaming', ids: [id] });
      ({ anime } = await send({ type: 'anime', id }));
      if (detailStack.at(-1) !== id) return;
      detailAnime = anime;
      renderDetail();
    }
  } catch (e) {
    if (detailStack.at(-1) !== id) return;
    if (detailAnime?.id === id) return showError(e); // la ficha ya está pintada: solo falló dónde verla
    box.replaceChildren(detailTop(id), el('div', { class: 'empty' }, `No he podido cargar la ficha: ${e.message}`));
  }
}

function renderDetail() {
  const a = detailAnime;
  const season = a.season && `${SEASON_NAMES[a.season.season]} ${a.season.year}`;
  const lines = [
    [MEDIA_TYPES[a.mediaType] || a.mediaType?.toUpperCase(), a.numEpisodes && `${a.numEpisodes} eps`, a.duration && `${Math.round(a.duration / 60)} min`],
    [AIR_STATUS[a.status], season],
    [a.studios.join(', '), SOURCES[a.source]],
  ]
    .map((parts) => parts.filter(Boolean).join(' · '))
    .filter(Boolean);
  const byYear = (x, y) => (x.year ?? 9999) - (y.year ?? 9999);
  const { anime: related, manga } = a.related;
  const prev = related.filter((r) => r.relation === 'prequel');
  const next = related.filter((r) => r.relation === 'sequel');
  const others = related
    .filter((r) => r.relation !== 'prequel' && r.relation !== 'sequel')
    .sort((x, y) => RELATION_ORDER.indexOf(x.relation) - RELATION_ORDER.indexOf(y.relation) || byYear(x, y));
  // Primero el manga o la novela en que se basa (o que lo adapta); después las otras versiones, por año.
  const mainManga = (m) => (['ADAPTATION', 'SOURCE'].includes(m.relation) ? 0 : 1);
  const mangas = [...manga].sort((x, y) => mainManga(x) - mainManga(y) || byYear(x, y));
  const box = $('#detail');
  box.replaceChildren();
  fill(
    box,
    detailTop(a.id),
    // Lo primero, lo que más se usa: ver el siguiente episodio (o cuándo sale).
    detailWatch(a),
    el(
      'div',
      { class: 'd-head' },
      a.picture ? el('img', { class: 'd-cover', src: a.picture, alt: `Portada de ${a.title}` }) : el('div', { class: 'd-cover' }),
      el(
        'div',
        { class: 'd-info' },
        el('h1', { class: 'd-title' }, a.title),
        a.enTitle && a.enTitle !== a.title && el('p', { class: 'd-alt' }, a.enTitle),
        lines.map((l) => el('p', { class: 'd-meta' }, l)),
        el(
          'div',
          { class: 'd-stats' },
          el('span', { class: 'd-score', title: 'Nota media en MAL' }, a.mean ? `★ ${a.mean.toFixed(2).replace('.', ',')}` : '★ –'),
          a.rank > 0 && el('span', { title: 'Puesto por nota en MAL' }, `#${a.rank}`),
          a.members > 0 && el('span', {}, `${compact.format(a.members)} miembros`),
        ),
      ),
    ),
    el('hr', { class: 'd-sep' }),
    data?.user && detailList(a),
    (prev.length > 0 || next.length > 0) &&
      el('div', { class: 'd-seq' }, prev.map((r) => seqCard(r, 'prev')), next.map((r) => seqCard(r, 'next'))),
    (a.synopsis || a.genres.length > 0) && detailSynopsis(a.synopsis, a.genres),
    a.platforms.length > 0 &&
      el(
        'div',
        { class: 'd-block' },
        el('span', { class: 'label' }, 'También en'),
        el('div', { class: 'd-chips' }, a.platforms.map((p) => el('a', { class: 'chip d-platform', href: p.url, target: '_blank' }, p.name))),
      ),
    others.length > 0 &&
      el('div', { class: 'd-block' }, el('span', { class: 'label' }, 'Más de la serie'), el('ul', { class: 'continue upcoming' }, others.map(relatedRow))),
    mangas.length > 0 &&
      el('div', { class: 'd-block' }, el('span', { class: 'label' }, 'Manga y novelas'), el('ul', { class: 'continue upcoming' }, mangas.map(mangaRow))),
  );
}

// "TV · 2017 · 170 eps": el tipo, el año y los episodios de un anime relacionado, lo que se sepa (en películas y
// especiales de uno, los episodios sobran).
const relatedMeta = (r) =>
  [MEDIA_TYPES[r.format] || r.format?.toUpperCase(), r.year, r.episodes > 1 && `${r.episodes} eps`].filter(Boolean);

// La precuela o la secuela: una tarjeta grande para seguir la historia hacia atrás o hacia delante, con su estado
// (en emisión, por estrenar) y el tuyo en la lista.
function seqCard(r, dir) {
  const status = RELATED_STATUS[r.status];
  return el(
    'a',
    { class: `d-seq-card ${dir}`, ...toDetail(r.id), title: `Ficha de ${r.title}` },
    el('span', { class: 'd-seq-dir' }, dir === 'prev' ? '‹ Anterior' : 'Siguiente ›'),
    el(
      'span',
      { class: 'd-seq-body' },
      r.picture ? el('img', { class: 'c-cover', src: r.picture, alt: '', loading: 'lazy' }) : el('span', { class: 'c-cover' }),
      el(
        'span',
        { class: 'c-info' },
        el('span', { class: 'c-title' }, r.title),
        el('span', { class: 'c-meta' }, relatedMeta(r).join(' · ')),
        status && el('span', { class: 'c-meta c-when' }, status),
        r.listStatus && el('span', { class: 'chip d-seq-mine' }, STATUS[r.listStatus] || r.listStatus),
      ),
    ),
  );
}

// Qué hacer ahora: ver el siguiente episodio donde se pueda o, si vas al día, cuándo sale.
function detailWatch(a) {
  if (a.status === 'not_yet_aired') return a.startDate && el('p', { class: 'd-when' }, startsOn(a.startDate));
  const done = a.listStatus?.status === 'completed' || (a.numEpisodes > 0 && a.watched >= a.numEpisodes);
  const next = a.airing?.next;
  if (!done && upToDate(a)) {
    return el('p', { class: 'd-when' }, next ? `Vas al día · el ep. ${next.episode} sale ${airDate(next.at)}` : 'Vas al día');
  }
  const open = openAction(a, null);
  if (!open.where) return next && el('p', { class: 'd-when' }, `El ep. ${next.episode} sale ${airDate(next.at)}`);
  const play = el('span', { class: 'd-play-icon' });
  play.innerHTML = PLAY_ICON;
  return el(
    'div',
    { class: 'd-block' },
    el(
      'a',
      { class: 'primary d-play', href: open.url, target: '_blank' },
      play,
      done ? `Ver en ${open.where}` : `Ver ep. ${a.watched + 1} en ${open.where}`,
    ),
    next && el('p', { class: 'small' }, `El ep. ${next.episode} sale ${airDate(next.at)}`),
  );
}

// Episodios vistos → lo que se guarda en MAL: al llegar al último pasa a completado; al empezar uno pendiente (o
// rebajar uno completado), a viendo. En pausa y abandonado se respetan.
function episodesForm(a, n) {
  const status = a.listStatus?.status;
  if (a.numEpisodes > 0 && n >= a.numEpisodes) return { episodes: n, status: 'completed' };
  if (n > 0 && ['plan_to_watch', 'completed'].includes(status)) return { episodes: n, status: 'watching' };
  return { episodes: n };
}

// Tu lista: estado, episodios vistos y nota. Cada cambio se guarda en MAL al momento.
function detailList(a) {
  const ls = a.listStatus;
  const save = (form) =>
    action(async () => {
      const res = await send({ type: 'updateList', id: a.id, ...form });
      if (detailAnime?.id !== a.id) return;
      Object.assign(a, { listStatus: res.listStatus, watched: res.watched });
      listChanged(a);
      renderDetail();
    });
  const status = el(
    'select',
    { class: 'sort', 'aria-label': 'Estado en tu lista', onchange: (e) => save({ status: e.target.value })(e) },
    !ls && el('option', { value: '', selected: true, disabled: true }, 'Añadir a mi lista…'),
    Object.entries(STATUS).map(([k, name]) => el('option', { value: k, selected: ls?.status === k }, name)),
  );
  if (!ls) return el('div', { class: 'd-block' }, el('span', { class: 'label' }, 'Tu lista'), el('div', { class: 'd-list' }, status));
  const total = a.numEpisodes;
  return el(
    'div',
    { class: 'd-block' },
    el('span', { class: 'label' }, 'Tu lista'),
    el(
      'div',
      { class: 'd-list' },
      status,
      el(
        'div',
        { class: 'd-stepper' },
        el('button', { 'aria-label': 'Un episodio menos', disabled: a.watched <= 0, onclick: save(episodesForm(a, a.watched - 1)) }, '−'),
        el('span', { title: 'Episodios vistos' }, el('strong', {}, String(a.watched)), ` / ${total || '?'}`),
        el('button', { 'aria-label': 'Un episodio más', disabled: total > 0 && a.watched >= total, onclick: save(episodesForm(a, a.watched + 1)) }, '+'),
      ),
      el(
        'select',
        { class: 'sort', 'aria-label': 'Tu nota', onchange: (e) => save({ score: Number(e.target.value) })(e) },
        el('option', { value: '0', selected: !ls.score }, 'Sin nota'),
        [10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((n) => el('option', { value: String(n), selected: ls.score === n }, `★ ${n}`)),
      ),
    ),
  );
}

// Lo cambiado en la ficha vale también para las pestañas: Mi lista y Seguir viendo se recargan al volver; en
// Temporada basta con retocar el estreno.
function listChanged(a) {
  listItems = null;
  continueItems = null;
  const item = seasonItems?.find((i) => i.id === a.id);
  if (item) Object.assign(item, { listStatus: a.listStatus?.status || null, watched: a.watched });
}

// La sinopsis (de MAL, en inglés), recortada a unas líneas con "Ver más", y debajo los géneros. Sin sinopsis, solo
// los géneros.
function detailSynopsis(text, genres) {
  const chips = genres.length > 0 && el('div', { class: 'd-chips' }, genres.map((g) => el('span', { class: 'chip' }, g)));
  if (!text) return el('div', { class: 'd-block' }, el('span', { class: 'label' }, 'Géneros'), chips);
  const p = el('p', { class: 'd-synopsis clamped' }, text);
  const more = el(
    'button',
    {
      class: 'link',
      onclick: () => {
        more.textContent = p.classList.toggle('clamped') ? 'Ver más' : 'Ver menos';
      },
    },
    'Ver más',
  );
  return el('div', { class: 'd-block' }, el('span', { class: 'label' }, 'Sinopsis'), p, text.length > 300 && more, chips);
}

// Un anime de "Más de la serie": abre su ficha.
function relatedRow(r) {
  const meta = [RELATIONS[r.relation] || r.relation, ...relatedMeta(r)].join(' · ');
  return el(
    'li',
    {},
    el(
      'a',
      { class: 'c-row', ...toDetail(r.id), title: `Ficha de ${r.title}` },
      r.picture ? el('img', { class: 'c-cover', src: r.picture, alt: '', loading: 'lazy' }) : el('span', { class: 'c-cover' }),
      el('span', { class: 'c-info' }, el('span', { class: 'c-title' }, r.title), el('span', { class: 'c-meta' }, meta)),
    ),
  );
}

// Un manga o novela: no hay ficha de mangas en el panel, abre la suya de MAL (o de AniList, si MAL no lo tiene).
function mangaRow(m) {
  const meta = [
    MANGA_FORMATS[m.format] || m.format,
    MANGA_RELATIONS[m.relation],
    m.year,
    m.volumes && `${m.volumes} ${m.volumes === 1 ? 'tomo' : 'tomos'}`,
    MANGA_STATUS[m.status],
  ].filter(Boolean);
  return el(
    'li',
    {},
    el(
      'a',
      { class: 'c-row', href: m.url, target: '_blank', title: `Abrir la ficha de ${m.title}` },
      m.picture ? el('img', { class: 'c-cover', src: m.picture, alt: '', loading: 'lazy' }) : el('span', { class: 'c-cover' }),
      el('span', { class: 'c-info' }, el('span', { class: 'c-title' }, m.title), el('span', { class: 'c-meta' }, meta.join(' · '))),
      el('span', { class: 'd-ext', 'aria-hidden': 'true' }, '↗'),
    ),
  );
}

$('#tabNow').addEventListener('click', () => setView('now'));
$('#tabList').addEventListener('click', () => setView('list'));
$('#tabSeason').addEventListener('click', () => setView('season'));
$('#seasonPrev').addEventListener('click', () => moveSeason(-1));
$('#seasonNext').addEventListener('click', () => moveSeason(1));
$('#seasonSort').value = seasonSort;
$('#seasonSort').addEventListener('change', (e) => {
  seasonSort = e.target.value;
  store.set('seasonSort', seasonSort);
  if (seasonItems) renderSeason();
});
$('#listFilter').addEventListener('input', () => listItems && renderList());
$('#onlyCR').setAttribute('aria-pressed', String(onlyCR));
crToggle($('#onlyCR'));
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
  // Esc cierra el panel aunque el foco esté dentro del iframe; con una ficha abierta, primero vuelve atrás.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (detailStack.length) closeDetail();
    else parent.postMessage({ malAuto: 'closePanel' }, '*');
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
    seasonItems = null;
    if (view === 'list') setTimeout(() => loadList().catch(showError), 300);
    if (view === 'season') setTimeout(() => loadSeason().catch(showError), 300);
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
