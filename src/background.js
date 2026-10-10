import * as mal from './mal.js';
import { rankCandidates } from './matcher.js';
import { getSettings, SITES } from './settings.js';

// Por debajo de esta similitud no se marca nada sin que lo confirmes en el panel.
const AUTO_CONFIDENCE = 0.75;

// ---------- Estado por pestaña (en storage.session para sobrevivir a que Chrome duerma el service worker)

const tabKey = (tabId) => `tab:${tabId}`;
async function getTab(tabId) {
  return (await chrome.storage.session.get(tabKey(tabId)))[tabKey(tabId)] || null;
}
async function setTab(tabId, state) {
  await chrome.storage.session.set({ [tabKey(tabId)]: state });
  updateBadge(tabId, state);
  pushMascot(tabId, state);
}
chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(tabKey(tabId)));

// ---------- Asociaciones guardadas "anime de la web" -> id de MAL

const mapKey = (info) => `${info.site}:${info.key}`;
async function getMappings() {
  return (await chrome.storage.local.get('mappings')).mappings || {};
}
async function saveMapping(info, value) {
  const mappings = await getMappings();
  mappings[mapKey(info)] = value;
  await chrome.storage.local.set({ mappings });
}

// ---------- Resolución: qué anime y qué episodio de MAL corresponde a lo que estás viendo

const summary = (node) => ({
  id: node.id,
  title: node.title,
  picture: node.main_picture?.medium || null,
  pictureLarge: node.main_picture?.large || node.main_picture?.medium || null,
  enTitle: node.alternative_titles?.en || null,
  numEpisodes: node.num_episodes || 0,
  mediaType: node.media_type,
  listStatus: node.my_list_status || null,
});

// Sigue la relación "sequel" de MAL quedándose solo con series (no películas ni especiales).
async function findSequel(node) {
  const sequels = (node.related_anime || []).filter((r) => r.relation_type === 'sequel');
  for (const r of sequels) {
    const next = await mal.getAnime(r.node.id);
    if (['tv', 'ona'].includes(next.media_type)) return next;
  }
  return null;
}

async function findBest(info) {
  const queries = [...new Set([info.title, ...(info.altTitles || [])].filter((q) => q && q.trim().length >= 3))];
  let best = null;
  for (const q of queries) {
    const ranked = rankCandidates(queries, await mal.search(q));
    if (ranked[0] && (!best || ranked[0].score > best.score)) best = ranked[0];
    if (best?.score >= 0.95) break;
  }
  // Plan B: el buscador de la web de MAL encuentra estrenos que el índice de la API aún no tiene.
  if (!best || best.score < AUTO_CONFIDENCE) {
    for (const q of queries) {
      const ranked = rankCandidates(queries, await mal.searchWeb(q));
      if (ranked[0] && (!best || ranked[0].score > best.score)) {
        // Del buscador web solo viene el título: pedimos la ficha completa a la API.
        best = { ...ranked[0], node: await mal.getAnime(ranked[0].id) };
      }
      if (best?.score >= 0.95) break;
    }
  }
  // Prime Video indica la temporada: partimos de la primera y avanzamos por las secuelas.
  if (best && info.season > 1) {
    let node = await mal.getAnime(best.id);
    for (let s = 1; s < info.season; s++) {
      const next = await findSequel(node);
      if (!next) {
        best.score = Math.min(best.score, 0.5);
        break;
      }
      node = next;
    }
    best = { ...best, id: node.id, node };
  }
  return best;
}

async function resolve(info) {
  let baseId;
  let offset = 0;
  let confidence = 1;
  const mapping = (await getMappings())[mapKey(info)];
  if (mapping) {
    baseId = mapping.malId;
    offset = mapping.offset || 0;
  } else {
    const best = await findBest(info);
    if (!best) return { phase: 'notFound' };
    if (best.score < AUTO_CONFIDENCE) {
      return { phase: 'lowConfidence', confidence: best.score, anime: summary(best.node), episode: info.episode };
    }
    baseId = best.id;
    confidence = best.score;
    await saveMapping(info, { malId: best.id, title: best.node.title, auto: true });
  }

  // Crunchyroll suele numerar seguido entre temporadas (JJK E25 = temporada 2 E1).
  let episode = info.episode - offset;
  let anime = await mal.getAnime(baseId);
  for (let i = 0; i < 8 && anime.num_episodes > 0 && episode > anime.num_episodes; i++) {
    const next = await findSequel(anime);
    if (!next) break;
    episode -= anime.num_episodes;
    anime = next;
  }
  if (episode < 1 || (anime.num_episodes > 0 && episode > anime.num_episodes)) {
    return { phase: 'outOfRange', anime: summary(anime), episode, confidence };
  }
  return { phase: 'matched', anime: summary(anime), episode, confidence };
}

// Evita repetir búsquedas en MAL para el mismo episodio mientras el service worker sigue vivo.
const resolving = new Map();
function resolveCached(info, { force = false } = {}) {
  const k = `${mapKey(info)}#${info.episode}`;
  if (force) resolving.delete(k);
  if (!resolving.has(k)) {
    const p = resolve(info).catch((e) => ({ phase: 'error', error: e.message }));
    resolving.set(k, p);
    p.then(() => setTimeout(() => resolving.get(k) === p && resolving.delete(k), 60_000));
  }
  return resolving.get(k);
}

// ---------- Eventos

async function onEpisode(tabId, info, { force = false } = {}) {
  const epKey = `${mapKey(info)}#${info.episode}`;
  const prev = await getTab(tabId);
  if (!force && prev?.epKey === epKey && prev.phase !== 'error') return prev;
  let state = { info, epKey, phase: 'resolving', marked: prev?.epKey === epKey && prev.marked };
  await setTab(tabId, state);
  state = { ...state, ...(await resolveCached(info, { force })) };
  // Si mientras buscábamos cambió de episodio, no pisamos el estado nuevo.
  if ((await getTab(tabId))?.epKey !== epKey) return state;
  await setTab(tabId, state);
  if (state.phase === 'matched') await saveWatchLink(state);
  return state;
}

// Recuerda en qué web ves cada anime para enlazar al siguiente episodio desde "Mi lista".
async function saveWatchLink(state) {
  const { info, anime, episode } = state;
  if (!info.link) return;
  const { watchLinks = {} } = await chrome.storage.local.get('watchLinks');
  // delta: diferencia entre la numeración de la web y la de MAL (temporadas numeradas seguidas).
  watchLinks[anime.id] = { site: info.site, ...info.link, delta: info.episode - episode, at: Date.now() };
  await chrome.storage.local.set({ watchLinks });
}

function watchUrl(link, watched, total) {
  if (!link) return null;
  const next = watched + 1;
  if (link.template && (!total || next <= total)) return link.template.replace('{ep}', next + (link.delta || 0));
  return link.page || null;
}

// ---------- Dónde se puede ver de forma oficial. La ficha web de MAL lista las plataformas (la API oficial
// no lo da). Su marca de "disponible en tu región" no es fiable (JJK sale como no disponible y está en
// Crunchyroll España), así que cuenta que MAL lo liste. Sus enlaces de Crunchyroll son antiguos y acaban
// en la portada, por eso el panel abre la búsqueda de Crunchyroll con el título.

const STREAM_TTL = 7 * 24 * 3600 * 1000;

async function getStreamingCache() {
  return (await chrome.storage.local.get('platforms')).platforms || {};
}

async function fetchStreaming(id) {
  const res = await fetch(`https://myanimelist.net/anime/${id}`, { credentials: 'omit' });
  if (!res.ok) throw new Error(`MAL ${res.status}`);
  const html = await res.text();
  const platforms = [];
  for (const [tag] of html.matchAll(/<a\b[^>]*\bbroadcast-item\b[^>]*>/g)) {
    const href = tag.match(/href="([^"]+)"/)?.[1]?.replace(/&amp;/g, '&');
    const name = tag.match(/title="([^"]+)"/)?.[1];
    const available = /\bbroadcast-item available\b/.test(tag);
    if (href && name) platforms.push({ name, url: href.replace(/^http:/, 'https:'), available });
  }
  return {
    at: Date.now(),
    crunchyroll: platforms.some((p) => /crunchyroll/i.test(p.name)),
    platforms,
  };
}

// Las descargas de fichas van de una en una para no saturar MAL.
let streamingQueue = Promise.resolve();

async function getStreaming(ids, { maxFetch = 8 } = {}) {
  const cache = await getStreamingCache();
  const crunchyroll = {};
  const missing = [];
  for (const id of ids) {
    const c = cache[id];
    if (c && Date.now() - c.at < STREAM_TTL) crunchyroll[id] = c.crunchyroll;
    else missing.push(id);
  }
  const toFetch = missing.slice(0, maxFetch);
  if (toFetch.length) {
    const job = streamingQueue.then(async () => {
      const fetched = {};
      for (const id of toFetch) {
        try {
          fetched[id] = await fetchStreaming(id);
          crunchyroll[id] = fetched[id].crunchyroll;
        } catch (e) {
          console.warn('[MAL Auto] plataformas', id, e.message);
          if (/\b(403|429)\b/.test(e.message)) break; // MAL nos frena: lo dejamos para luego
        }
        await new Promise((r) => setTimeout(r, 400));
      }
      const fresh = await getStreamingCache();
      for (const [id, entry] of Object.entries(fetched)) {
        // Si ya comprobamos que Crunchyroll no lo tiene, que MAL lo siga enlazando no cambia nada.
        fresh[id] = { ...fresh[id], ...entry, ...(fresh[id]?.crMissing && { crunchyroll: false }) };
      }
      await chrome.storage.local.set({ platforms: fresh });
    });
    streamingQueue = job.catch(() => {});
    await job;
  }
  return { crunchyroll, pending: missing.length - toFetch.length };
}

// El panel abrió el buscador de Crunchyroll y la extensión dio con la serie: se recuerda para ir directo.
async function saveCrunchyrollUrl(malId, url) {
  if (!/^https:\/\/www\.crunchyroll\.com\/(?:[a-z-]+\/)?series\//.test(url)) return;
  const cache = await getStreamingCache();
  cache[malId] = { at: Date.now(), platforms: [], ...cache[malId], crunchyroll: true, crUrl: url, crMissing: false };
  await chrome.storage.local.set({ platforms: cache });
}

async function getMyList(status) {
  if (!(await mal.getUser())) throw new Error('Conecta tu cuenta de MyAnimeList para ver tu lista.');
  const [items, { watchLinks = {} }, streaming] = await Promise.all([
    mal.getMyList(status),
    chrome.storage.local.get('watchLinks'),
    getStreamingCache(),
  ]);
  return items.map(({ node, list_status: ls }) => {
    const link = watchLinks[node.id];
    const stream = streaming[node.id];
    const total = node.num_episodes || 0;
    const watched = ls?.num_episodes_watched || 0;
    return {
      id: node.id,
      title: node.title,
      picture: node.main_picture?.medium || null,
      numEpisodes: total,
      watched,
      status: ls?.status,
      site: link?.site || null,
      watchUrl: watchUrl(link, watched, total),
      nextEpisode: link?.template && (!total || watched < total) ? watched + 1 : null,
      // undefined = aún no comprobado (el panel lo pide aparte); false = no está en Crunchyroll
      crunchyroll: stream && Date.now() - stream.at < STREAM_TTL ? !!stream.crunchyroll : undefined,
      // Título para buscar en Crunchyroll: el inglés suele ser el que usan ellos.
      enTitle: node.alternative_titles?.en || null,
      crUrl: stream?.crUrl || null,
    };
  });
}

async function onThreshold(tabId) {
  const state = await getTab(tabId);
  if (!state || state.marked) return;
  const settings = await getSettings();
  if (!settings.sites[state.info.site]) return;
  await markTab(tabId, { manual: false });
}

async function markTab(tabId, { manual }) {
  let state = await getTab(tabId);
  if (!state) throw new Error('No hay ningún episodio detectado en esta pestaña.');
  if (state.marked && !manual) return state;

  if (!(await mal.getUser())) {
    toast(tabId, 'MAL Auto Tracker: conecta tu cuenta de MyAnimeList desde el icono de la extensión.', 'warn');
    return state;
  }

  state = { ...state, ...(await resolveCached(state.info)) };
  if (state.phase !== 'matched') {
    const msg = {
      lowConfidence: `No estoy seguro de qué anime es "${state.info.title}". Confírmalo desde el icono de la extensión.`,
      notFound: `No encontré "${state.info.title}" en MyAnimeList. Asígnalo desde el icono de la extensión.`,
      outOfRange: `El episodio ${state.info.episode} no encaja con "${state.anime?.title}". Corrígelo desde el icono de la extensión.`,
      error: `Error con MyAnimeList: ${state.error}`,
    }[state.phase];
    if (msg) toast(tabId, msg, 'warn');
    state.marked = true; // no insistir en cada timeupdate
    await setTab(tabId, state);
    return state;
  }

  const anime = await mal.getAnime(state.anime.id, { fresh: true });
  const ls = anime.my_list_status;
  const ep = state.episode;
  const total = anime.num_episodes || 0;
  const done = total > 0 && ep >= total;
  let result;

  if (ls?.status === 'completed' && !ls.is_rewatching) {
    result = 'alreadyCompleted';
    toast(tabId, `"${anime.title}" ya está completado en tu lista. Si es otra temporada, corrígelo desde el icono de la extensión.`, 'info');
  } else if (ls && ls.num_episodes_watched >= ep) {
    result = 'alreadyWatched';
    if (manual) toast(tabId, `"${anime.title}" ya tenía el episodio ${ls.num_episodes_watched} marcado.`, 'info');
  } else {
    const today = new Date().toLocaleDateString('sv-SE'); // AAAA-MM-DD
    const form = { num_watched_episodes: ep };
    if (ls?.is_rewatching) {
      if (done) Object.assign(form, { is_rewatching: false, status: 'completed' });
    } else {
      form.status = done ? 'completed' : 'watching';
      if (!ls || ls.status === 'plan_to_watch') form.start_date = today;
      if (done) form.finish_date = today;
    }
    try {
      await mal.updateListStatus(anime.id, form);
    } catch (e) {
      toast(tabId, `No se pudo actualizar MyAnimeList: ${e.message}`, 'error');
      throw e;
    }
    result = 'updated';
    toast(tabId, `✓ MyAnimeList: ${anime.title} — episodio ${ep}${total ? `/${total}` : ''}${done ? ' · ¡completado!' : ''}`, 'ok');
    await addHistory({ id: anime.id, title: anime.title, episode: ep, total, done, site: state.info.site, at: Date.now() });
  }

  state = { ...state, anime: summary(await mal.getAnime(anime.id)), marked: true, result };
  await setTab(tabId, state);
  return state;
}

async function setMapping(tabId, malId, offset = 0) {
  const state = await getTab(tabId);
  if (!state) throw new Error('No hay ningún episodio detectado en esta pestaña.');
  const anime = await mal.getAnime(malId);
  await saveMapping(state.info, { malId: anime.id, title: anime.title, offset: Number(offset) || 0, auto: false });
  const next = { info: state.info, epKey: state.epKey, marked: false, ...(await resolveCached(state.info, { force: true })) };
  await setTab(tabId, next);
  if (next.phase === 'matched') await saveWatchLink(next);
  return next;
}

async function addHistory(entry) {
  const { history = [] } = await chrome.storage.local.get('history');
  history.unshift(entry);
  await chrome.storage.local.set({ history: history.slice(0, 30) });
}

// ---------- Avisos

async function toast(tabId, text, kind) {
  if (!(await getSettings()).toasts) return;
  chrome.tabs.sendMessage(tabId, { type: 'toast', text, kind }, { frameId: 0 }).catch(() => {});
}

// ---------- Mascota de la web (esquina inferior izquierda de las webs compatibles)

// Qué cara pone y qué dice (en el tooltip) según lo que esté pasando en la pestaña: idle fuera de un episodio,
// curious dentro y excited cuando lo acabas. `site` hace falta cuando aún no hay episodio.
async function mascotFor(state, site) {
  const settings = await getSettings();
  site = state?.info.site || site;
  if (!settings.mascot || !settings.sites[site]) return { show: false };
  const say = (mood, text) => ({ show: true, mood, text });
  if (!settings.clientId || !(await mal.getUser())) return say('idle', 'Pulsa aquí y conecta tu cuenta de MAL: te acompaño viendo anime.');
  if (!state) return say('idle', `¿Qué vemos hoy en ${SITES[site]}? Elige un episodio y lo apunto.`);
  const { phase, episode, anime, info } = state;
  if (state.marked) {
    return say('excited', state.result === 'updated'
      ? `¡Episodio ${episode} visto! Ya está apuntado en tu lista.`
      : `¡Episodio ${episode} acabado! Ya lo tenías en tu lista.`);
  }
  if (phase === 'resolving') return say('curious', `Buscando "${info.title}" en MyAnimeList…`);
  if (phase === 'matched') return say('curious', `¡Episodio ${episode} de ${anime.title}! Lo marco cuando acabe.`);
  if (phase === 'error') return say('curious', 'Algo ha fallado con MyAnimeList… Pulsa para verlo.');
  return say('curious', 'Mmm… no sé seguro qué anime es. Pulsa y me echas una mano.');
}

async function pushMascot(tabId, state, site) {
  const m = await mascotFor(state, site);
  chrome.tabs.sendMessage(tabId, { type: 'mascot', ...m }, { frameId: 0 }).catch(() => {});
}

function updateBadge(tabId, state) {
  const [text, color] = !state
    ? ['', '#000']
    : state.marked && state.result === 'updated'
      ? ['✓', '#d97757']
      : ['lowConfidence', 'notFound', 'outOfRange', 'error'].includes(state.phase)
        ? ['?', '#ffd27a']
        : state.phase === 'matched'
          ? ['•', '#b8b9c0']
          : ['', '#000'];
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  chrome.action.setBadgeTextColor({ tabId, color: '#141413' }).catch(() => {});
}

// ---------- Mensajes

async function handle(msg, sender) {
  const tabId = msg.tabId ?? sender.tab?.id;
  switch (msg.type) {
    case 'getMascot':
      return await mascotFor(await getTab(tabId), msg.site);
    case 'episode':
      if (sender.frameId !== 0) return {};
      return { state: await onEpisode(tabId, msg.info) };
    case 'noEpisode':
      if (sender.frameId === 0) {
        await chrome.storage.session.remove(tabKey(tabId));
        updateBadge(tabId, null);
        pushMascot(tabId, null, msg.site);
      }
      return {};
    case 'threshold':
      await onThreshold(tabId);
      return {};
    case 'getState': {
      const settings = await getSettings();
      const { history = [] } = await chrome.storage.local.get('history');
      let state = await getTab(tabId);
      if (state?.phase === 'error') state = await onEpisode(tabId, state.info, { force: true });
      let crunchyroll = null;
      let crUrl = null;
      if (state?.anime && state.info.site !== 'crunchyroll') {
        const cached = (await getStreamingCache())[state.anime.id];
        if (cached) ({ crunchyroll, crUrl = null } = cached);
        // Sin comprobar todavía: se pide en segundo plano y el panel se refresca al guardarse.
        else getStreaming([state.anime.id]).catch(() => {});
      }
      return {
        state,
        crunchyroll,
        crUrl,
        user: await mal.getUser(),
        configured: !!settings.clientId,
        threshold: settings.threshold,
        history: history.slice(0, 5),
        sites: SITES,
      };
    }
    case 'markNow':
      return { state: await markTab(tabId, { manual: true }) };
    case 'myList':
      return { items: await getMyList(msg.status) };
    case 'crSeriesFound':
      await saveCrunchyrollUrl(Number(msg.malId), String(msg.url));
      return {};
    case 'crSeriesMissing': {
      const cache = await getStreamingCache();
      const id = Number(msg.malId);
      cache[id] = { at: Date.now(), platforms: [], ...cache[id], crunchyroll: false, crUrl: null, crMissing: true };
      await chrome.storage.local.set({ platforms: cache });
      return {};
    }
    case 'streaming':
      return await getStreaming(msg.ids || []);
    case 'search': {
      let results = await mal.search(msg.query);
      if (!results.length) results = await mal.searchWeb(msg.query);
      return { results: results.map(summary) };
    }
    case 'setMapping':
      return { state: await setMapping(tabId, msg.malId, msg.offset) };
    case 'login': {
      const user = await mal.login();
      // Lo resuelto antes de conectar no incluía tu lista: se vuelve a pedir.
      const state = await getTab(tabId);
      if (state) await onEpisode(tabId, state.info, { force: true });
      return { user };
    }
    case 'logout':
      await mal.logout();
      return {};
    default:
      throw new Error(`Mensaje desconocido: ${msg.type}`);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(
    (r) => sendResponse({ ok: true, ...r }),
    (e) => sendResponse({ ok: false, error: e.message }),
  );
  return true;
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install' && !(await getSettings()).clientId) chrome.runtime.openOptionsPage();
});
