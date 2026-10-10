export const SITES = {
  crunchyroll: 'Crunchyroll',
  jkanime: 'JKAnime',
  animeflv: 'AnimeFLV',
  primevideo: 'Prime Video',
};

export const DEFAULTS = {
  clientId: '',
  clientSecret: '',
  threshold: 0.85,
  toasts: true,
  mascot: true,
  sites: { crunchyroll: true, jkanime: true, animeflv: true, primevideo: true },
};

export async function getSettings() {
  const { settings = {} } = await chrome.storage.sync.get('settings');
  return { ...DEFAULTS, ...settings, sites: { ...DEFAULTS.sites, ...settings.sites } };
}

export async function saveSettings(patch) {
  const settings = { ...(await getSettings()), ...patch };
  await chrome.storage.sync.set({ settings });
  return settings;
}
