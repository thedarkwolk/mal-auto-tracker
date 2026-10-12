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

// ---------- AniList: API pública, sin cuenta; se busca por id de MAL, hasta 50 animes por petición.

const ANILIST = 'https://graphql.anilist.co';

async function anilistMedia(query, ids) {
  const res = await fetch(ANILIST, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables: { ids } }),
  });
  if (!res.ok) throw new Error(`AniList ${res.status}`);
  return (await res.json()).data?.Page?.media || [];
}

// ---------- Dónde se puede ver de forma oficial. Se cruzan dos fuentes:
// - AniList, en lote: los enlaces de streaming que mantiene su comunidad, sin país. Si tiene plataformas y
//   ninguna es Crunchyroll, no está. Su enlace a Crunchyroll suele ir directo a la serie.
// - La ficha web de MAL, de una en una (la API oficial no lo da): datos de JustWatch para el país desde el que se
//   pide, o sea, el tuyo. Solo cuenta Crunchyroll si MAL lo marca "available": también lista plataformas de otros
//   países (Steins;Gate enlazaba a Crunchyroll Argentina) y eso hacía ofrecer animes que aquí no están.
// JustWatch tarda en añadir las temporadas nuevas (Black Clover 2nd Season salía "no disponible" la semana de su
// estreno), así que en lo que se emite o acaba de terminar basta con que AniList enlace a Crunchyroll, sin
// preguntar a MAL. Solo se descarga la ficha cuando AniList no lo deja claro.

const STREAM_TTL = 7 * 24 * 3600 * 1000;
// Sube si cambia cómo se interpreta la ficha: las entradas guardadas con otra versión se vuelven a pedir.
const STREAM_VERSION = 3;
// Hasta cuánto después de acabar se fía de AniList sin mirar MAL.
const STREAM_RECENT = 90 * 24 * 3600 * 1000;

async function getStreamingCache() {
  return (await chrome.storage.local.get('platforms')).platforms || {};
}

const streamFresh = (c) => !!c && c.v === STREAM_VERSION && Date.now() - c.at < STREAM_TTL;

// Una búsqueda en Crunchyroll que no encontró el anime vale lo que dura la caché, no para siempre.
const crMissingNow = (c) => !!c?.crMissing && Date.now() - (c.crMissingAt || 0) < STREAM_TTL;

// Enlace de MAL a Crunchyroll → página de Crunchyroll de un anime (serie o episodio), o null si no lleva a una
// (los antiguos "series-283782" o la portada no sirven).
function crunchyrollPage(url) {
  let target = url;
  try {
    const u = new URL(url);
    if (u.hostname === 'click.justwatch.com') target = u.searchParams.get('r') || '';
  } catch {
    return null;
  }
  target = target.replace(/^http:/, 'https:');
  return /^https:\/\/www\.crunchyroll\.com\/(?:[a-z-]+\/)?(?:series|watch)\/[A-Z0-9]+/.test(target) ? target : null;
}

// La página de Crunchyroll que se guarda, de entre los enlaces que den las fuentes: la de la serie, directa; si
// no hay, la de un episodio (el panel la abre y desde ahí se salta a la serie); si tampoco, el panel busca.
function crPages(urls) {
  const pages = urls.map((u) => u && crunchyrollPage(u)).filter(Boolean);
  const series = pages.find((p) => /\/series\//.test(p));
  return series ? { crUrl: series } : { crLink: pages[0] || null };
}

const STREAMING_QUERY = `query ($ids: [Int]) {
  Page(perPage: 50) {
    media(idMal_in: $ids, type: ANIME) {
      idMal status endDate { year month day }
      externalLinks { site url type isDisabled }
    }
  }
}`;

// { [malId]: { platforms, cr, recent } } de los que AniList conoce: cr = su enlace a Crunchyroll (o null) y
// recent = en emisión, por estrenar o acabado hace poco. Si AniList falla, {}: todo se mira en MAL.
async function getAnilistStreaming(ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    try {
      for (const m of await anilistMedia(STREAMING_QUERY, ids.slice(i, i + 50))) {
        const platforms = (m.externalLinks || [])
          .filter((l) => l.type === 'STREAMING' && !l.isDisabled)
          .map((l) => ({ name: l.site, url: l.url.replace(/^http:/, 'https:') }));
        const { year, month, day } = m.endDate || {};
        const ended = year ? new Date(year, (month || 12) - 1, day || 28).getTime() : null;
        out[m.idMal] = {
          platforms,
          cr: platforms.find((p) => /crunchyroll/i.test(p.name))?.url || null,
          recent: ['RELEASING', 'NOT_YET_RELEASED'].includes(m.status) || (!!ended && Date.now() - ended < STREAM_RECENT),
        };
      }
    } catch (e) {
      console.warn('[MAL Auto] AniList plataformas', e.message);
      break;
    }
  }
  return out;
}

// Lo que AniList deja claro sin mirar MAL, o null si hace falta la ficha: no tiene plataformas (le faltan datos),
// o enlaza a Crunchyroll pero es antiguo (puede no estar en tu país).
function streamingFromAnilist(a) {
  if (!a?.platforms.length) return null;
  const entry = { v: STREAM_VERSION, at: Date.now(), source: 'anilist', platforms: a.platforms };
  if (!a.cr) return { ...entry, crunchyroll: false };
  return a.recent ? { ...entry, crunchyroll: true, ...crPages([a.cr]) } : null;
}

// anilistCr: el enlace de AniList a Crunchyroll, por si la ficha de MAL no lleva a la serie.
async function fetchStreaming(id, anilistCr) {
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
  const cr = platforms.find((p) => /crunchyroll/i.test(p.name) && p.available);
  return {
    v: STREAM_VERSION,
    at: Date.now(),
    crunchyroll: !!cr,
    ...(cr ? crPages([cr.url, anilistCr]) : { crLink: null }),
    platforms,
  };
}

// Las descargas de fichas van de una en una para no saturar MAL.
let streamingQueue = Promise.resolve();

// Devuelve { crunchyroll: { [malId]: bool }, links: { [malId]: { crUrl, crLink } } de los recién comprobados,
// pending } (pending = los que quedan por mirar en MAL, más allá de maxFetch).
async function getStreaming(ids, { maxFetch = 8 } = {}) {
  const cache = await getStreamingCache();
  const crunchyroll = {};
  const links = {};
  const missing = [];
  for (const id of ids) {
    const c = cache[id];
    if (streamFresh(c)) crunchyroll[id] = c.crunchyroll && !crMissingNow(c);
    else missing.push(id);
  }
  if (!missing.length) return { crunchyroll, links, pending: 0 };

  const anilist = await getAnilistStreaming(missing);
  const fetched = {};
  const needMal = [];
  for (const id of missing) {
    const entry = streamingFromAnilist(anilist[id]);
    if (entry) fetched[id] = entry;
    else needMal.push(id);
  }
  const toFetch = needMal.slice(0, maxFetch);
  const job = streamingQueue.then(async () => {
    for (const id of toFetch) {
      try {
        fetched[id] = await fetchStreaming(id, anilist[id]?.cr);
      } catch (e) {
        console.warn('[MAL Auto] plataformas', id, e.message);
        if (/\b(403|429)\b/.test(e.message)) break; // MAL nos frena: lo dejamos para luego
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    const fresh = await getStreamingCache();
    for (const [id, entry] of Object.entries(fetched)) {
      // Se conserva la serie que ya encontró el panel (crUrl) y, mientras no caduque, el "no está" de una
      // búsqueda fallida.
      const prev = fresh[id] || {};
      fresh[id] = { ...entry, crUrl: entry.crUrl || prev.crUrl || null };
      if (crMissingNow(prev)) Object.assign(fresh[id], { crMissing: true, crMissingAt: prev.crMissingAt });
      crunchyroll[id] = fresh[id].crunchyroll && !crMissingNow(fresh[id]);
      links[id] = { crUrl: fresh[id].crUrl, crLink: fresh[id].crLink || null };
    }
    await chrome.storage.local.set({ platforms: fresh });
  });
  streamingQueue = job.catch(() => {});
  await job;
  return { crunchyroll, links, pending: needMal.length - toFetch.length };
}

// El panel abrió el buscador de Crunchyroll y la extensión dio con la serie: se recuerda para ir directo.
async function saveCrunchyrollUrl(malId, url) {
  if (!/^https:\/\/www\.crunchyroll\.com\/(?:[a-z-]+\/)?series\//.test(url)) return;
  const cache = await getStreamingCache();
  cache[malId] = { at: Date.now(), platforms: [], ...cache[malId], crunchyroll: true, crUrl: url, crMissing: false };
  if (cache[malId].v !== STREAM_VERSION) cache[malId].at = 0; // la ficha está sin leer con el criterio actual
  await chrome.storage.local.set({ platforms: cache });
}

// ---------- Episodios emitidos, de AniList. Sirve para saber si vas al día con un anime en emisión y no
// ofrecer "Ver" cuando aún no ha salido el siguiente episodio.

const AIRING_TTL = 6 * 3600 * 1000;
const AIRING_QUERY = `query ($ids: [Int]) {
  Page(perPage: 50) {
    media(idMal_in: $ids, type: ANIME) { idMal status episodes nextAiringEpisode { episode airingAt } }
  }
}`;

// Una entrada guardada caduca a las 6 h o en cuanto se emite el episodio que esperaba, lo que llegue antes.
const airingFresh = (a) => a && Date.now() - a.at < AIRING_TTL && !(a.next && Date.now() >= a.next.at);

// Devuelve { [malId]: { aired, next } }: aired = último episodio emitido (null si no se sabe) y
// next = { episode, at } del siguiente, si hay fecha. Los que AniList no conoce no aparecen.
async function getAiring(ids) {
  const { airing: cache = {} } = await chrome.storage.local.get('airing');
  const missing = ids.filter((id) => !airingFresh(cache[id]));
  for (let i = 0; i < missing.length; i += 50) {
    const chunk = missing.slice(i, i + 50);
    try {
      const media = await anilistMedia(AIRING_QUERY, chunk);
      for (const id of chunk) cache[id] = { at: Date.now(), aired: null, next: null }; // por si AniList no lo tiene
      for (const m of media) {
        const next = m.nextAiringEpisode;
        cache[m.idMal] = {
          at: Date.now(),
          aired: next ? next.episode - 1 : m.status === 'FINISHED' ? m.episodes : null,
          next: next ? { episode: next.episode, at: next.airingAt * 1000 } : null,
        };
      }
    } catch (e) {
      console.warn('[MAL Auto] AniList', e.message); // sin datos: el panel se comporta como siempre
      break;
    }
  }
  await chrome.storage.local.set({ airing: cache });
  return Object.fromEntries(ids.filter((id) => cache[id]).map((id) => [id, { aired: cache[id].aired, next: cache[id].next }]));
}

// Estrenos de una temporada (series de TV y ONA que empiezan en ella), de más a menos populares, con lo que ya se
// sepa de Crunchyroll. Las continuaciones de otras temporadas se quedan fuera: ya salen en "Seguir viendo".
async function getSeasonList(year, season) {
  const [nodes, streaming] = await Promise.all([mal.getSeason(year, season), getStreamingCache()]);
  return nodes
    .filter((n) => ['tv', 'ona'].includes(n.media_type))
    .filter((n) => n.start_season?.year === year && n.start_season?.season === season)
    .map((node) => {
      const stream = streaming[node.id];
      const ls = node.my_list_status;
      return {
        id: node.id,
        title: node.title,
        enTitle: node.alternative_titles?.en || null,
        picture: node.main_picture?.medium || null,
        numEpisodes: node.num_episodes || 0,
        mediaType: node.media_type,
        mean: node.mean || null,
        members: node.num_list_users || 0,
        onAir: node.status === 'currently_airing',
        // Aún sin estrenar: la fecha de estreno (puede venir solo con año y mes)
        startDate: node.status === 'not_yet_aired' ? node.start_date || null : null,
        listStatus: ls?.status || null,
        watched: ls?.num_episodes_watched || 0,
        crunchyroll: streamFresh(stream) ? stream.crunchyroll && !crMissingNow(stream) : undefined,
        crUrl: stream?.crUrl || null,
        crLink: streamFresh(stream) ? stream.crLink || null : null,
      };
    });
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
      score: ls?.score || 0,
      site: link?.site || null,
      watchUrl: watchUrl(link, watched, total),
      nextEpisode: link?.template && (!total || watched < total) ? watched + 1 : null,
      // undefined = aún no comprobado (el panel lo pide aparte); false = no está en Crunchyroll
      crunchyroll: streamFresh(stream) ? stream.crunchyroll && !crMissingNow(stream) : undefined,
      // Título para buscar en Crunchyroll: el inglés suele ser el que usan ellos.
      enTitle: node.alternative_titles?.en || null,
      crUrl: stream?.crUrl || null,
      crLink: streamFresh(stream) ? stream.crLink || null : null,
    };
  });
}

// Enlace de JustWatch (los de la ficha de MAL) → la página de la plataforma, que va dentro en "r=".
function justWatchTarget(url) {
  try {
    const u = new URL(url);
    return (u.hostname === 'click.justwatch.com' && u.searchParams.get('r')) || url;
  } catch {
    return url;
  }
}

// Relacionados según AniList: tipo, año y estado de cada uno, también de los mangas y novelas (la API de MAL solo da
// los animes, y sin nada de eso). Si AniList falla, []: la ficha se queda con lo de MAL.
const RELATIONS_QUERY = `query ($ids: [Int]) {
  Page(perPage: 1) {
    media(idMal_in: $ids, type: ANIME) {
      relations {
        edges {
          relationType
          node {
            idMal type format status episodes volumes siteUrl
            startDate { year } title { romaji } coverImage { medium }
          }
        }
      }
    }
  }
}`;
const relationsCache = new Map();
async function getAnilistRelations(id) {
  const hit = relationsCache.get(id);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.edges;
  try {
    const [media] = await anilistMedia(RELATIONS_QUERY, [id]);
    const edges = media?.relations?.edges || [];
    relationsCache.set(id, { edges, at: Date.now() });
    return edges;
  } catch (e) {
    console.warn('[MAL Auto] AniList relacionados', e.message);
    return [];
  }
}

// Relacionados de la ficha. Los animes salen de MAL (sus ids son los que abren ficha) con el tipo, el año y el
// estado de AniList; la precuela y la secuela, además, con tu estado en la lista. Los mangas y novelas, de AniList.
// Los videoclips se quedan fuera: no son parte de la historia.
async function getRelated(node, edges) {
  const fromAnilist = new Map(edges.filter((e) => e.node.type === 'ANIME' && e.node.idMal).map((e) => [e.node.idMal, e.node]));
  const anime = await Promise.all(
    (node.related_anime || []).map(async ({ node: r, relation_type: relation }) => {
      const a = fromAnilist.get(r.id);
      const mine = ['prequel', 'sequel'].includes(relation) ? await mal.getAnime(r.id).catch(() => null) : null;
      return {
        id: r.id,
        title: r.title,
        picture: r.main_picture?.medium || a?.coverImage?.medium || null,
        relation,
        format: a?.format?.toLowerCase() || mine?.media_type || null,
        year: a?.startDate?.year || null,
        episodes: a?.episodes || mine?.num_episodes || null,
        status: a?.status || null,
        listStatus: mine?.my_list_status?.status || null,
      };
    }),
  );
  const manga = edges
    .filter((e) => e.node.type === 'MANGA')
    .map(({ node: m, relationType }) => ({
      title: m.title.romaji,
      picture: m.coverImage?.medium || null,
      relation: relationType,
      format: m.format,
      year: m.startDate?.year || null,
      volumes: m.volumes || null,
      status: m.status,
      url: m.idMal ? `https://myanimelist.net/manga/${m.idMal}` : m.siteUrl,
    }));
  return { anime: anime.filter((a) => a.format !== 'music'), manga };
}

// Ficha del panel: los datos de MAL, dónde verlo (lo guardado de Crunchyroll y de la web donde lo ves) y, si se
// emite, el siguiente episodio. crunchyroll undefined = sin comprobar (el panel lo pide aparte y vuelve a pedir
// la ficha, que ya está en caché).
async function getAnimeDetail(id) {
  const [node, { watchLinks = {} }, streaming, airing, edges] = await Promise.all([
    mal.getAnimeFull(id),
    chrome.storage.local.get('watchLinks'),
    getStreamingCache(),
    getAiring([id]),
    getAnilistRelations(id),
  ]);
  const stream = streaming[id];
  const fresh = streamFresh(stream);
  const ls = node.my_list_status;
  const total = node.num_episodes || 0;
  const watched = ls?.num_episodes_watched || 0;
  const link = watchLinks[id];
  return {
    id,
    title: node.title,
    enTitle: node.alternative_titles?.en || null,
    picture: node.main_picture?.large || node.main_picture?.medium || null,
    synopsis: (node.synopsis || '').replace(/\s*\[Written by MAL Rewrite\]\s*$/i, '').trim() || null,
    mean: node.mean || null,
    rank: node.rank || null,
    members: node.num_list_users || 0,
    genres: (node.genres || []).map((g) => g.name),
    studios: (node.studios || []).map((s) => s.name),
    mediaType: node.media_type,
    status: node.status,
    source: node.source || null,
    duration: node.average_episode_duration || 0,
    numEpisodes: total,
    startDate: node.start_date || null,
    season: node.start_season || null,
    related: await getRelated(node, edges),
    listStatus: ls ? { status: ls.status, score: ls.score || 0 } : null,
    watched,
    airing: airing[id] || null,
    site: link?.site || null,
    watchUrl: watchUrl(link, watched, total),
    crunchyroll: fresh ? stream.crunchyroll && !crMissingNow(stream) : undefined,
    crUrl: stream?.crUrl || null,
    crLink: fresh ? stream.crLink || null : null,
    // Las demás plataformas, solo las que MAL da como disponibles en tu país.
    platforms: fresh
      ? (stream.platforms || [])
          .filter((p) => p.available && !/crunchyroll/i.test(p.name))
          .map((p) => ({ name: p.name, url: justWatchTarget(p.url) }))
      : [],
  };
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
    toast(tabId, { kind: 'warn', title: 'Conecta tu cuenta de MyAnimeList', text: 'Pulsa aquí y conéctala desde el panel.', fix: true });
    return state;
  }

  state = { ...state, ...(await resolveCached(state.info)) };
  if (state.phase !== 'matched') {
    // Todos se arreglan desde el panel: pulsar el aviso lo abre.
    const msg = {
      lowConfidence: { title: '¿Qué anime es?', text: `No estoy seguro de que sea "${state.info.title}". Pulsa aquí y elígelo.` },
      notFound: { title: 'No lo encuentro en MyAnimeList', text: `"${state.info.title}". Pulsa aquí y asígnalo.` },
      outOfRange: {
        title: 'Ese episodio no encaja',
        text: `El ${state.info.episode} no cuadra con "${state.anime?.title}". Pulsa aquí y corrígelo.`,
      },
      error: { title: 'Error con MyAnimeList', text: String(state.error) },
    }[state.phase];
    if (msg) toast(tabId, { kind: 'warn', fix: true, ...msg });
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
    toast(tabId, {
      kind: 'info',
      title: 'Ya lo tenías completado',
      text: `"${anime.title}". Si es otra temporada, pulsa aquí y corrígelo.`,
      picture: anime.main_picture?.medium,
      fix: true,
    });
  } else if (ls && ls.num_episodes_watched >= ep) {
    result = 'alreadyWatched';
    if (manual) {
      toast(tabId, {
        kind: 'info',
        title: 'Ya estaba marcado',
        text: `${anime.title} · episodio ${ls.num_episodes_watched}`,
        picture: anime.main_picture?.medium,
      });
    }
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
      toast(tabId, { kind: 'error', title: 'No se pudo actualizar MyAnimeList', text: e.message });
      throw e;
    }
    result = 'updated';
    // Al acabar el anime, el aviso pide además una nota (la que ya tuviera en MAL sale marcada).
    toast(tabId, {
      kind: 'ok',
      title: done ? '¡Anime completado!' : `Episodio ${ep} marcado`,
      text: done ? `${anime.title} · ¿Qué nota le das?` : `${anime.title} · ${ep}${total ? `/${total}` : ''}`,
      picture: anime.main_picture?.medium,
      ...(done && { rate: { id: anime.id, title: anime.title, score: ls?.score || 0 } }),
    });
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

// Aviso en la web: { kind: ok | info | warn | error, title, text, picture (portada), fix (pulsarlo abre el panel),
// rate: { id, title, score } (pide una nota del 1 al 10) }
async function toast(tabId, notice) {
  if (!(await getSettings()).toasts) return;
  chrome.tabs.sendMessage(tabId, { type: 'toast', notice }, { frameId: 0 }).catch(() => {});
}

// ---------- Mascota de la web (esquina inferior izquierda de las webs compatibles)

// Qué dice el bot (en el tooltip) según lo que esté pasando en la pestaña. `site` hace falta cuando aún no hay
// episodio.
async function mascotFor(state, site) {
  const settings = await getSettings();
  site = state?.info.site || site;
  if (!settings.mascot || !settings.sites[site]) return { show: false };
  const say = (text) => ({ show: true, text });
  if (!settings.clientId || !(await mal.getUser())) return say('Pulsa aquí y conecta tu cuenta de MAL: te acompaño viendo anime.');
  if (!state) return say(`¿Qué vemos hoy en ${SITES[site]}? Elige un episodio y lo apunto.`);
  const { phase, episode, anime, info } = state;
  if (state.marked) {
    return say(state.result === 'updated'
      ? `¡Episodio ${episode} visto! Ya está apuntado en tu lista.`
      : `¡Episodio ${episode} acabado! Ya lo tenías en tu lista.`);
  }
  if (phase === 'resolving') return say(`Buscando "${info.title}" en MyAnimeList…`);
  if (phase === 'matched') return say(`¡Episodio ${episode} de ${anime.title}! Lo marco cuando acabe.`);
  if (phase === 'error') return say('Algo ha fallado con MyAnimeList… Pulsa para verlo.');
  return say('Mmm… no sé seguro qué anime es. Pulsa y me echas una mano.');
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

// Lo que pueden pedir los scripts metidos en las webs (src/content): avisar de lo que ven, pedir qué dice el bot y
// votar desde el aviso. Todo lo demás (tu lista, cambiarla, conectar o desconectar la cuenta…) solo las páginas de la
// extensión: el popup, las opciones y el panel, también cuando va incrustado en una web. Una web no puede hablar con
// el background, pero si se comprometiera el proceso de una, su script no podría ir más allá de esto.
const FROM_WEB = new Set(['episode', 'noEpisode', 'threshold', 'getMascot', 'rate', 'crSeriesFound', 'crSeriesMissing']);
// Por el esquema y no por la dirección exacta: el panel incrustado va con una dirección dinámica (use_dynamic_url),
// con otro id. sender.url lo pone el navegador; una web no puede hacerse pasar por chrome-extension:.
const fromExtension = (sender) => sender.id === chrome.runtime.id && /^chrome-extension:/.test(sender.url || '');

async function handle(msg, sender) {
  const trusted = fromExtension(sender);
  if (!trusted && !FROM_WEB.has(msg?.type)) throw new Error(`Mensaje no permitido: ${msg?.type}`);
  // Un script de una web solo habla de su propia pestaña
  const tabId = (trusted ? msg.tabId : undefined) ?? sender.tab?.id;
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
      let crLink = null;
      if (state?.anime && state.info.site !== 'crunchyroll') {
        const cached = (await getStreamingCache())[state.anime.id];
        if (streamFresh(cached)) {
          ({ crUrl = null, crLink = null } = cached);
          crunchyroll = cached.crunchyroll && !crMissingNow(cached);
        }
        // Sin comprobar todavía: se pide en segundo plano y el panel se refresca al guardarse.
        else getStreaming([state.anime.id]).catch(() => {});
      }
      return {
        state,
        crunchyroll,
        crUrl,
        crLink,
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
    case 'season':
      return { items: await getSeasonList(Number(msg.year), String(msg.season)) };
    case 'rate': {
      // Nota desde el aviso de anime acabado (1-10; 0 la quita).
      const score = Math.round(Number(msg.score));
      if (!(score >= 0 && score <= 10)) throw new Error('Nota no válida.');
      await mal.updateListStatus(Number(msg.id), { score });
      return { score };
    }
    case 'addToList': {
      // Desde la pestaña Temporada: se apunta como pendiente (o el estado que pida el panel).
      if (!(await mal.getUser())) throw new Error('Conecta tu cuenta de MyAnimeList para añadir animes.');
      const status = ['plan_to_watch', 'watching'].includes(msg.status) ? msg.status : 'plan_to_watch';
      await mal.updateListStatus(Number(msg.id), { status });
      return { status };
    }
    case 'anime':
      return { anime: await getAnimeDetail(Number(msg.id)) };
    case 'updateList': {
      // Desde la ficha: estado, episodios vistos y nota, cualquiera de ellos.
      if (!(await mal.getUser())) throw new Error('Conecta tu cuenta de MyAnimeList para editar tu lista.');
      const form = {};
      if (msg.status != null) {
        if (!['watching', 'completed', 'on_hold', 'dropped', 'plan_to_watch'].includes(msg.status)) throw new Error('Estado no válido.');
        form.status = msg.status;
      }
      if (msg.episodes != null) form.num_watched_episodes = Math.max(0, Math.round(Number(msg.episodes)) || 0);
      if (msg.score != null) {
        const score = Math.round(Number(msg.score));
        if (!(score >= 0 && score <= 10)) throw new Error('Nota no válida.');
        form.score = score;
      }
      const ls = await mal.updateListStatus(Number(msg.id), form);
      return { listStatus: { status: ls.status, score: ls.score || 0 }, watched: ls.num_episodes_watched || 0 };
    }
    case 'crSeriesFound':
      await saveCrunchyrollUrl(Number(msg.malId), String(msg.url));
      return {};
    case 'crSeriesMissing': {
      const cache = await getStreamingCache();
      const id = Number(msg.malId);
      cache[id] = { at: Date.now(), platforms: [], ...cache[id], crUrl: null, crMissing: true, crMissingAt: Date.now() };
      await chrome.storage.local.set({ platforms: cache });
      return {};
    }
    case 'streaming':
      return await getStreaming(msg.ids || []);
    case 'airing':
      return { airing: await getAiring((msg.ids || []).map(Number)) };
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
