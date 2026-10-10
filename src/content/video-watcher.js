// Se inyecta en todos los frames (los reproductores de JKAnime/AnimeFLV/Crunchyroll van en iframes de otros dominios)
// y avisa al background cuando un vídeo supera el porcentaje configurado. El background decide si la pestaña
// tiene un episodio detectado; si no, el aviso se ignora.
(() => {
  if (window.__malAutoVideoWatcher) return;
  window.__malAutoVideoWatcher = true;

  const MIN_DURATION = 90; // segundos: descarta anuncios y previews
  let threshold = 0.85;

  try {
    chrome.storage.sync.get('settings').then(({ settings }) => {
      if (settings?.threshold) threshold = settings.threshold;
    });
    chrome.storage.onChanged.addListener((changes) => {
      const t = changes.settings?.newValue?.threshold;
      if (t) threshold = t;
    });
  } catch {
    return;
  }

  const armed = new WeakMap();

  // timeupdate no burbujea, pero sí pasa por la fase de captura del documento.
  document.addEventListener(
    'timeupdate',
    (e) => {
      const v = e.target;
      if (!(v instanceof HTMLVideoElement)) return;
      const d = v.duration;
      if (!d || !isFinite(d) || d < MIN_DURATION) return;
      const ratio = v.currentTime / d;
      if (ratio < 0.2) armed.set(v, true); // empieza un vídeo nuevo (o se rebobina): se puede volver a avisar
      if (ratio >= threshold && armed.get(v) !== false) {
        armed.set(v, false);
        try {
          chrome.runtime.sendMessage({ type: 'threshold', duration: d }).catch(() => {});
        } catch {
          // extensión recargada
        }
      }
    },
    true,
  );
})();
