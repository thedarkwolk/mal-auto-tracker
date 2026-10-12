// Se inyecta en todos los frames (los reproductores de JKAnime/AnimeFLV/Crunchyroll van en iframes de otros dominios)
// y avisa al background cuando un vídeo supera el porcentaje configurado. El background decide si la pestaña
// tiene un episodio detectado; si no, el aviso se ignora.
(() => {
  if (window.__malAutoVideoWatcher) return;
  window.__malAutoVideoWatcher = true;

  const MIN_DURATION = 90; // segundos: descarta anuncios y previews
  // El umbral se pide al background (este script no lee lo guardado de la extensión) y solo cuando hace falta: la
  // primera vez que se ve un vídeo largo, para no despertar a la extensión en cada frame de cada web. Si cambia en las
  // opciones, el background lo avisa.
  let threshold = null;
  let asked = false;
  const ask = () => {
    asked = true;
    chrome.runtime
      .sendMessage({ type: 'getThreshold' })
      .then((r) => r?.ok && (threshold = r.threshold))
      .catch(() => {});
  };
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'settingsChanged' && msg.threshold) threshold = msg.threshold;
    });
  } catch {
    return; // extensión recargada
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
      if (threshold === null) {
        if (!asked) {
          try {
            ask();
          } catch {
            // extensión recargada
          }
        }
        return;
      }
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
