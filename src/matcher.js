// Comparación aproximada de títulos (Dice sobre bigramas) para elegir la entrada de MAL correcta.

export function normalize(s = '') {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`´]/g, '')
    .replace(/&/g, ' and ')
    .replace(/(\d+)(?:st|nd|rd|th)\s+season/g, 'season $1')
    .replace(/\b(?:temporada|temp)\s*(\d+)/g, 'season $1')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(?:the|tv|sub|dub|espanol|latino|castellano|japones)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function bigrams(s) {
  const map = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    map.set(g, (map.get(g) || 0) + 1);
  }
  return map;
}

const numbers = (s) => (s.match(/\d+/g) || []).sort().join(',');

export function similarity(a, b) {
  a = normalize(a);
  b = normalize(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  for (const [g, n] of A) inter += Math.min(n, B.get(g) || 0);
  let score = (2 * inter) / (a.length - 1 + b.length - 1);
  // "Jujutsu Kaisen" no debe confundirse con "Jujutsu Kaisen 0" ni "Season 2" con "Season 3".
  if (numbers(a) !== numbers(b)) score -= 0.15;
  return Math.max(0, score);
}

// Quita la temporada/parte del título: en Crunchyroll todas las temporadas son una misma serie.
export function stripSeason(s = '') {
  return s
    .replace(/\b(?:the\s+)?final\s+season\b/gi, '')
    .replace(/\b\d+(?:st|nd|rd|th)\s+(?:season|cour)\b/gi, '')
    .replace(/\b(?:season|part|cour)\s*\d+\b/gi, '')
    .replace(/\s*[:\-–]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function rankCandidates(queries, nodes) {
  return nodes
    .map((node, i) => {
      const alt = node.alternative_titles || {};
      const names = [node.title, alt.en, ...(alt.synonyms || [])].filter(Boolean);
      let score = 0;
      for (const q of queries) for (const n of names) score = Math.max(score, similarity(q, n));
      if (['tv', 'ona'].includes(node.media_type)) score += 0.03;
      score -= i * 0.005;
      return { id: node.id, node, score: Math.min(1, Math.max(0, score)) };
    })
    .sort((a, b) => b.score - a.score);
}
