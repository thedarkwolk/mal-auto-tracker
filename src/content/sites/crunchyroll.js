// Abierto desde el panel ("…/search?q=…#malauto=<id>&t=<título>"): elige el resultado que corresponde
// al anime de MAL, entra en la serie y le pasa el enlace al background para ir directo la próxima vez.
(async () => {
  const marker = location.hash.match(/malauto=(\d+)/);
  if (!marker || !location.pathname.includes('/search')) return;
  const malId = Number(marker[1]);
  const titles = new URLSearchParams(location.hash.slice(1)).getAll('t').filter(Boolean);
  history.replaceState(null, '', location.pathname + location.search);
  const { similarity, stripSeason } = await import(chrome.runtime.getURL('src/matcher.js'));
  const wanted = [...new Set(titles.flatMap((t) => [t, stripSeason(t)]))];

  let best = null;
  for (let i = 0; i < 40 && !best; i++) {
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
    else if (i > 16) break; // hay resultados pero ninguno encaja
  }

  if (best) {
    try {
      await chrome.runtime.sendMessage({ type: 'crSeriesFound', malId, url: best });
    } catch {}
    location.replace(best);
  } else {
    // MAL lo enlaza pero Crunchyroll (en tu región) no lo tiene: deja de tener prioridad.
    try {
      await chrome.runtime.sendMessage({ type: 'crSeriesMissing', malId });
    } catch {}
    MALAuto.toast(`No he encontrado "${titles[0]}" en Crunchyroll: te dejo la búsqueda.`, 'warn');
  }
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
});
