// https://jkanime.net/sousou-no-frieren/5/
// <h1>Episodio 5 Japones - Sousou no Frieren</h1>
MALAuto.start(() => {
  const m = location.pathname.match(/^\/([^/]+)\/(\d+)\/?$/);
  if (!m) return null;
  const [, slug, episode] = m;
  const heading = MALAuto.text('h1');
  if (!/Episodio\s*\d+/i.test(heading)) return null;

  const seriesLink = [...document.querySelectorAll('a')].find(
    (a) => a.pathname === `/${slug}/` && a.textContent.trim(),
  );
  const title =
    seriesLink?.textContent.trim() || heading.split(/\s+-\s+/).slice(1).join(' - ') || MALAuto.slugToTitle(slug);

  return {
    site: 'jkanime',
    key: slug,
    title,
    altTitles: [MALAuto.slugToTitle(slug)],
    episode: Number(episode),
    link: { template: `${location.origin}/${slug}/{ep}/`, page: `${location.origin}/${slug}/` },
  };
});
