// Cliente mínimo de la API v2 de MyAnimeList con OAuth2 (PKCE "plain", que es lo único que acepta MAL).
import { getSettings } from './settings.js';

const API = 'https://api.myanimelist.net/v2';
const OAUTH = 'https://myanimelist.net/v1/oauth2';
const SEARCH_FIELDS = 'alternative_titles,num_episodes,media_type,main_picture';
const DETAIL_FIELDS = 'title,main_picture,alternative_titles,num_episodes,media_type,related_anime,my_list_status';

export const redirectUri = () => chrome.identity.getRedirectURL();

function randomString(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

async function getAuth() {
  return (await chrome.storage.local.get('auth')).auth || null;
}

export async function getUser() {
  return (await getAuth())?.user || null;
}

async function tokenRequest(params) {
  const { clientId, clientSecret } = await getSettings();
  const body = new URLSearchParams({ client_id: clientId, ...params });
  if (clientSecret) body.set('client_secret', clientSecret);
  const res = await fetch(`${OAUTH}/token`, { method: 'POST', body });
  if (!res.ok) throw new Error(`Error al obtener el token de MAL (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const t = await res.json();
  const prev = await getAuth();
  const auth = {
    ...prev,
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: Date.now() + t.expires_in * 1000,
  };
  await chrome.storage.local.set({ auth });
  return auth;
}

let refreshing = null;
function refresh() {
  refreshing ??= (async () => {
    const auth = await getAuth();
    if (!auth?.refreshToken) throw new Error('Sesión de MAL caducada, vuelve a conectar.');
    try {
      return await tokenRequest({ grant_type: 'refresh_token', refresh_token: auth.refreshToken });
    } catch (e) {
      await chrome.storage.local.remove('auth');
      throw new Error('Sesión de MAL caducada, vuelve a conectar.');
    }
  })().finally(() => (refreshing = null));
  return refreshing;
}

async function accessToken() {
  let auth = await getAuth();
  if (!auth?.accessToken) return null;
  if (auth.expiresAt - Date.now() < 24 * 3600 * 1000) auth = await refresh();
  return auth.accessToken;
}

async function api(path, { method = 'GET', form, retried = false } = {}) {
  const headers = {};
  const token = await accessToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  } else {
    const { clientId } = await getSettings();
    if (!clientId) throw new Error('Falta el Client ID de MAL (configúralo en Opciones).');
    headers['X-MAL-CLIENT-ID'] = clientId;
  }
  let body;
  if (form) {
    body = new URLSearchParams(form);
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  const res = await fetch(API + path, { method, headers, body });
  if (res.status === 401 && token && !retried) {
    await refresh();
    return api(path, { method, form, retried: true });
  }
  if (!res.ok) throw new Error(`MAL respondió ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export async function login() {
  const { clientId } = await getSettings();
  if (!clientId) throw new Error('Falta el Client ID de MAL (configúralo en Opciones).');
  const verifier = randomString(64);
  const state = randomString(16);
  const url = new URL(`${OAUTH}/authorize`);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    code_challenge: verifier,
    code_challenge_method: 'plain',
    state,
    redirect_uri: redirectUri(),
  });
  const result = await chrome.identity.launchWebAuthFlow({ url: url.href, interactive: true });
  const params = new URL(result).searchParams;
  if (params.get('error')) throw new Error(`MAL rechazó el acceso: ${params.get('error')}`);
  if (params.get('state') !== state) throw new Error('Respuesta de MAL inválida (state).');
  await tokenRequest({
    grant_type: 'authorization_code',
    code: params.get('code'),
    code_verifier: verifier,
    redirect_uri: redirectUri(),
  });
  const me = await api('/users/@me');
  const auth = { ...(await getAuth()), user: { name: me.name, picture: me.picture || null } };
  await chrome.storage.local.set({ auth });
  animeCache.clear();
  fullCache.clear();
  return auth.user;
}

export async function logout() {
  await chrome.storage.local.remove('auth');
}

export async function search(q) {
  // MAL rechaza búsquedas de menos de 3 caracteres o demasiado largas.
  q = q.trim();
  if (q.length > 60) q = q.slice(0, 60).replace(/\s+\S*$/, '');
  if (q.length < 3) return [];
  // nsfw: sin esto la API oculta animes clasificados como R-17+ (p. ej. "Kimi ga Shinu made Koi wo Shitai").
  const data = await api(`/anime?${new URLSearchParams({ q, limit: 10, nsfw: 'true', fields: SEARCH_FIELDS })}`);
  return data.data.map((d) => d.node);
}

// Buscador de la web de MAL (el autocompletado de su barra de búsqueda). Va más al día que el índice
// de la API con los estrenos, así que sirve de plan B. Solo da id, título y tipo.
export async function searchWeb(q) {
  q = q.trim().slice(0, 100);
  if (q.length < 3) return [];
  const res = await fetch(
    `https://myanimelist.net/search/prefix.json?${new URLSearchParams({ type: 'anime', keyword: q, v: 1 })}`,
    { credentials: 'omit' },
  );
  if (!res.ok) return [];
  const data = await res.json();
  const items = data.categories?.find((c) => c.type === 'anime')?.items || [];
  return items.map((i) => ({
    id: i.id,
    title: i.name,
    media_type: (i.payload?.media_type || '').toLowerCase(),
    main_picture: i.image_url ? { medium: i.image_url } : undefined,
  }));
}

const animeCache = new Map();
export async function getAnime(id, { fresh = false } = {}) {
  const hit = animeCache.get(id);
  if (!fresh && hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.node;
  const node = await api(`/anime/${id}?fields=${DETAIL_FIELDS}`);
  animeCache.set(id, { node, at: Date.now() });
  return node;
}

// Todo lo que enseña la ficha del panel. Caché aparte de la de getAnime: lleva más campos.
const FULL_FIELDS =
  'title,main_picture,alternative_titles,start_date,synopsis,mean,rank,num_list_users,genres,media_type,status,' +
  'num_episodes,start_season,source,average_episode_duration,studios,related_anime,my_list_status';
const fullCache = new Map();
export async function getAnimeFull(id) {
  const hit = fullCache.get(id);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.node;
  const node = await api(`/anime/${id}?fields=${FULL_FIELDS}`);
  fullCache.set(id, { node, at: Date.now() });
  return node;
}

// Animes de una temporada (season: winter, spring, summer o fall), de más a menos populares. Con sesión, cada uno
// trae tu estado en la lista (my_list_status). Incluye los que siguen emitiéndose de temporadas anteriores.
const SEASON_FIELDS =
  'alternative_titles,num_episodes,media_type,main_picture,mean,num_list_users,start_season,start_date,status,my_list_status';
export async function getSeason(year, season) {
  const params = new URLSearchParams({ sort: 'anime_num_list_users', limit: 300, nsfw: 'true', fields: SEASON_FIELDS });
  const data = await api(`/anime/season/${year}/${season}?${params}`);
  return data.data.map((d) => d.node);
}

// Tu lista, de la más reciente a la más antigua. Sin estado = todas.
export async function getMyList(status) {
  const params = new URLSearchParams({
    fields: 'list_status,num_episodes,media_type,alternative_titles',
    sort: 'list_updated_at',
    limit: 100,
    nsfw: 'true',
  });
  if (status) params.set('status', status);
  const items = [];
  let path = `/users/@me/animelist?${params}`;
  while (path && items.length < 1000) {
    const page = await api(path);
    items.push(...page.data);
    path = page.paging?.next ? page.paging.next.replace(API, '') : null;
  }
  return items;
}

export async function updateListStatus(id, form) {
  const res = await api(`/anime/${id}/my_list_status`, { method: 'PATCH', form });
  animeCache.delete(id);
  fullCache.delete(id);
  return res;
}
