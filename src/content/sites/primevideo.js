// Reproductor de Prime Video (primevideo.com o amazon.xx/gp/video). Solo detecta mientras el reproductor
// está abierto. Los títulos suelen venir traducidos, así que es la web donde más falla la búsqueda:
// si no encaja, asígnalo una vez desde el panel y se recuerda para esa temporada.
MALAuto.start(() => {
  const title = MALAuto.text('.atvwebplayersdk-title-text');
  const subtitle = MALAuto.text('.atvwebplayersdk-subtitle-text');
  if (!title || !subtitle || !document.querySelector('video')) return null;

  // "Temp. 1, ep. 5 Título" / "Season 1, Ep. 5 Title" / "Ep. 5 Título"
  const se = subtitle.match(
    /(?:Season|Temporada|Temp\.?|T)\s*(\d+)\s*[,.:·]?\s*(?:Episode|Episodio|Ep\.?|E)\s*(\d+)/i,
  );
  const onlyEp = subtitle.match(/(?:Episode|Episodio|Ep\.?)\s*(\d+)/i);
  if (!se && !onlyEp) return null;
  const season = se ? Number(se[1]) : 1;
  const episode = Number(se ? se[2] : onlyEp[1]);

  return {
    site: 'primevideo',
    key: `${title.toLowerCase()}:s${season}`,
    title,
    altTitles: [],
    season,
    episode,
    link: { page: location.href },
  };
});
