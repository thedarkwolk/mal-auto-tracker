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
                { class: 'cr-hint', href: crPage({ ...anime, crUrl: data.crUrl, crLink: data.crLink }), target: '_blank' },
                el('span', { class: 'cr-hint-text' }, crIcon(), 'Disponible en ', el('strong', {}, 'Crunchyroll')),
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
  // Los filtros de cada pestaña van en la barra de abajo (la franja del bot)
  $('#listBar').hidden = v !== 'list';
  $('#seasonBar').hidden = v !== 'season';
  $('#filterBar').classList.toggle('empty', v === 'now');
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

// Prioridad al abrir: Crunchyroll > la web donde lo estabas viendo > ficha de MAL.
function openAction(item, malUrl) {
  const crUrl =
    (item.site === 'crunchyroll' && item.watchUrl) || item.crUrl || (item.crunchyroll ? crPage(item) : null);
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
    // Solo para los que se enseñan: qué episodios han salido (AniList) y dónde se pueden ver (una vez).
    const ids = continueItems.map((i) => i.id);
    const unchecked = continueItems.filter((i) => i.crunchyroll === undefined).map((i) => i.id);
    await Promise.all([
      send({ type: 'airing', ids }).then(({ airing }) => {
        for (const item of continueItems || []) item.airing = airing[item.id] || null;
        renderContinue();
      }),
      unchecked.length &&
        send({ type: 'streaming', ids: unchecked }).then(({ crunchyroll }) => {
          for (const item of continueItems || []) {
            if (unchecked.includes(item.id)) item.crunchyroll = item.id in crunchyroll ? crunchyroll[item.id] : false;
          }
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

// Una fila de "para ver": entera es el enlace al siguiente episodio (o a la ficha de MAL si no hay dónde verlo).
function continueRow(item) {
  const open = openAction(item, `https://myanimelist.net/anime/${item.id}`);
  const next = item.watched + 1;
  const pct = item.numEpisodes ? Math.min(100, (item.watched / item.numEpisodes) * 100) : 0;
  const aired = item.airing?.aired;
  const pending = aired != null ? aired - item.watched : null;
  const playIcon = el('span', { class: `c-play${open.where ? '' : ' mal'}` }, open.where ? '' : 'MAL');
  if (open.where) playIcon.innerHTML = PLAY_ICON;
  return el(
    'li',
    {},
    el(
      'a',
      {
        class: 'c-row',
        href: open.url,
        target: '_blank',
        title: open.where ? `Ver el episodio ${next} en ${open.where}` : `${item.title} en MyAnimeList`,
      },
      // Dónde se abre lo dicen el logo de Crunchyroll y el título de la fila; abajo, solo el episodio.
      cover(item),
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
      playIcon,
    ),
  );
}

// Una fila de "al día": compacta, con cuándo sale el siguiente; enlaza a la ficha de MAL.
function upcomingRow(item) {
  const next = item.airing?.next;
  return el(
    'li',
    {},
    el(
      'a',
      { class: 'c-row', href: `https://myanimelist.net/anime/${item.id}`, target: '_blank', title: `${item.title} en MyAnimeList` },
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
  box.replaceChildren(
    toWatch.length
      ? el('ul', { class: 'continue' }, toWatch.map(continueRow))
      : el('div', { class: 'empty' }, 'Vas al día con todo lo que estás viendo.'),
    caughtUp.length && el('span', { class: 'label' }, 'Al día · próximos episodios'),
    caughtUp.length && el('ul', { class: 'continue upcoming' }, caughtUp.map(upcomingRow)),
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
        withCrBadge(item, item.picture ? el('img', { class: 'thumb', src: item.picture, alt: '' }) : el('div', { class: 'thumb' })),
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
    const { crunchyroll } = await send({ type: 'streaming', ids });
    if (!seasonItems || seasonLoadedFor !== key) return;
    for (const item of seasonItems) {
      if (ids.includes(item.id)) item.crunchyroll = item.id in crunchyroll ? crunchyroll[item.id] : false;
    }
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

function seasonRow(item) {
  const malUrl = `https://myanimelist.net/anime/${item.id}`;
  const meta = [
    item.mediaType === 'ona' ? 'ONA' : 'TV',
    item.numEpisodes ? `${item.numEpisodes} eps` : null,
    item.mean ? `★ ${item.mean.toFixed(2).replace('.', ',')}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return el(
    'li',
    { class: 's-row' },
    el(
      'a',
      { class: 's-link', href: malUrl, target: '_blank', title: `${item.title} en MyAnimeList` },
      cover(item),
      el(
        'span',
        { class: 'c-info' },
        el('span', { class: 'c-title' }, item.title),
        el('span', { class: 'c-meta' }, meta),
        item.next && el('span', { class: 'c-meta' }, `Ep. ${item.next.episode} ${airDate(item.next.at)}`),
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

$('#tabNow').addEventListener('click', () => setView('now'));
$('#tabList').addEventListener('click', () => setView('list'));
$('#tabSeason').addEventListener('click', () => setView('season'));
$('#seasonPrev').addEventListener('click', () => moveSeason(-1));
$('#seasonNext').addEventListener('click', () => moveSeason(1));
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
