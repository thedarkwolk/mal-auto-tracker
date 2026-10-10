// https://www3.animeflv.net/ver/sousou-no-frieren-5
MALAuto.start(() => {
  const m = location.pathname.match(/^\/ver\/(.+)-(\d+)\/?$/);
  if (!m) return null;
  const [, slug, episode] = m;

  const stripEpisode = (s) =>
    s
      .replace(/\s*(?:Episodio|Ep\.?)\s*\d+.*$/i, '')
      .replace(/\s*[-—|]\s*AnimeFLV.*$/i, '')
      .trim();
  const title =
    stripEpisode(MALAuto.text('h1.Title')) ||
    MALAuto.text('.CapNvLs a[href^="/anime/"], a[href^="/anime/"].fa-th-list') ||
    stripEpisode(document.title) ||
    MALAuto.slugToTitle(slug);

  return {
    site: 'animeflv',
    key: slug,
    title,
    altTitles: [MALAuto.slugToTitle(slug)],
    episode: Number(episode),
    link: { template: `${location.origin}/ver/${slug}-{ep}`, page: `${location.origin}/anime/${slug}` },
  };
});
