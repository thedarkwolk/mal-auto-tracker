// Abierto desde el panel con una marca (#malauto=<id>) para dar con la serie del anime de MAL, entrar en ella
// y pasarle el enlace al background para ir directo la próxima vez. Dos casos:
// - "…/watch/<episodio>#malauto=<id>": el enlace que da MAL a un episodio; la serie es la de ese episodio.
// - "…/search?q=…#malauto=<id>&t=<título>&q=<otra búsqueda>…": elige el resultado que encaja con el título; si
//   ninguno encaja, prueba la siguiente búsqueda (q) y, agotadas, da el anime por no disponible.
(async () => {
  const marker = location.hash.match(/malauto=(\d+)/);
  if (!marker) return;
  const malId = Number(marker[1]);
  const params = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname + location.search);
  const found = async (url) => {
    try {
      await chrome.runtime.sendMessage({ type: 'crSeriesFound', malId, url });
    } catch {}
    location.replace(url);
  };

  if (/\/watch\//.test(location.pathname)) {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const href = document.querySelector('a.show-title-link, a[data-t="show-title-link"]')?.getAttribute('href');
      if (href && /\/series\//.test(href)) return found(new URL(href, location.origin).href);
    }
    return; // sin enlace a la serie: se queda en el episodio, que también vale
  }
  if (!location.pathname.includes('/search')) return;

  const titles = params.getAll('t').filter(Boolean);
  const { similarity, stripSeason } = await import(chrome.runtime.getURL('src/matcher.js'));
  const wanted = [...new Set(titles.flatMap((t) => [t, stripSeason(t)]))];

  // Se espera por tiempo, no por vueltas (en una pestaña en segundo plano los temporizadores van más lentos):
  // sin ningún resultado en 6 s se da la búsqueda por vacía; con resultados que no encajan, a los 4 s.
  let best = null;
  const start = Date.now();
  while (!best && Date.now() - start < 6000) {
    await new Promise((r) => setTimeout(r, 250));
    const links = [...document.querySelectorAll('a[href*="/series/"]')].filter((a) =>
      /search-show-card/.test(a.className),
    );
    if (!links.length) continue;
    const scores = new Map();
    for (const a of links) {
      const href = a.getAttribute('href');
      const slug = href.match(/\/series\/[^/]+\/([^/?#]+)/)?.[1];
      if (!slug) continue;
      // El slug va en inglés; el texto de la tarjeta, traducido. Vale cualquiera de los dos.
      const names = [slug.replace(/-/g, ' '), a.textContent.trim(), a.getAttribute('aria-label') || ''].filter(Boolean);
      const score = Math.max(...wanted.flatMap((w) => names.map((n) => similarity(w, n))));
      scores.set(href, Math.max(scores.get(href) || 0, score));
    }
    const [href, score] = [...scores].sort((a, b) => b[1] - a[1])[0] || [];
    if (href && score >= 0.7) best = new URL(href, location.origin).href;
    else if (Date.now() - start > 4000) break; // hay resultados pero ninguno encaja
  }

  if (best) return found(best);

  // Otra búsqueda pendiente: se prueba con la misma marca, quitando la que se va a usar.
  const [next, ...rest] = params.getAll('q');
  if (next) {
    const hash = new URLSearchParams([['malauto', malId], ...titles.map((t) => ['t', t]), ...rest.map((q) => ['q', q])]);
    const url = new URL(location.href);
    url.searchParams.set('q', next);
    url.hash = hash.toString();
    return location.replace(url.href);
  }

  // Ninguna búsqueda lo encuentra: deja de tener prioridad hasta que se vuelva a comprobar en MAL.
  try {
    await chrome.runtime.sendMessage({ type: 'crSeriesMissing', malId });
  } catch {}
  MALAuto.toast({ kind: 'warn', title: 'No está en Crunchyroll', text: `No he encontrado "${titles[0]}": te dejo la búsqueda.` });
})();

// https://www.crunchyroll.com/es/watch/G0DUND0K2/the-journeys-end
// El título visible está traducido ("Frieren: Tras finalizar el viaje"), pero el slug de la serie
// va en inglés ("frieren-beyond-journeys-end"), que encaja mucho mejor con MAL.
MALAuto.start(() => {
  if (!/\/watch\//.test(location.pathname)) return null;
  const link = document.querySelector('a.show-title-link, a[data-t="show-title-link"]');
  const heading = MALAuto.text('h1.title') || MALAuto.text('h1');
  const series = link?.getAttribute('href')?.match(/\/series\/([^/]+)\/([^/?#]+)/);
  if (!series || !heading) return null;

  // "E1 - El fin de la aventura"
  const ep = heading.match(/(?:^|\s)E(\d+)\b/) || heading.match(/Episodio\s*(\d+)/i);
  if (!ep) return null;

  return {
    site: 'crunchyroll',
    key: series[1],
    title: MALAuto.slugToTitle(series[2]),
    altTitles: [link.textContent.trim()],
    episode: Number(ep[1]),
    link: { page: new URL(link.getAttribute('href'), location.origin).href },
  };
}, {
  // Episodio anterior y siguiente: Crunchyroll los enlaza bajo el vídeo ([data-t="prev-episode"], "next-episode").
  nav: () => {
    const at = (which) => {
      const href = document.querySelector(`[data-t="${which}-episode"] a[href*="/watch/"]`)?.getAttribute('href');
      return href ? new URL(href, location.origin).href : null;
    };
    return { prev: at('prev'), next: at('next') };
  },
});
