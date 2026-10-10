// Mascota de MAL Auto: la bola de bloub (github.com/jeremy-prt/bloub, MIT), de un solo color.
// Cara según data-mood: idle (normal) · curious (dentro de un episodio) · excited (episodio acabado, bota).
// Color según data-tone: black (bola negra, para webs claras) · white (bola blanca, para webs oscuras).
// Los SVG (mascot/<mood>-<tone>.svg) solo animan los ojos (miran y parpadean); el bote del cuerpo va aquí por CSS.
// Script clásico (no módulo) para usarlo en las webs.
(() => {
  if (globalThis.MALMascot) return;

  const MOODS = ['idle', 'curious', 'excited'];
  const TONES = ['black', 'white'];
  const url = (face) => globalThis.chrome?.runtime?.getURL?.(`mascot/${face}.svg`) || `../mascot/${face}.svg`;

  const svg = `<span class="m-body">${MOODS.flatMap((m) =>
    TONES.map((t) => `<img class="m-face" data-face="${m}-${t}" src="${url(`${m}-${t}`)}" alt="" draggable="false">`),
  ).join('')}</span>`;

  // Se ve la cara del humor y tono actuales; sin atributos, idle en negro.
  const faces = MOODS.flatMap((m) =>
    TONES.map((t) => {
      const mood = m === 'idle' ? `:not([data-mood='curious']):not([data-mood='excited'])` : `[data-mood='${m}']`;
      const tone = t === 'black' ? `:not([data-tone='white'])` : `[data-tone='white']`;
      return `.mal-mascot${mood}${tone} .m-face[data-face='${m}-${t}'] { display: block; }`;
    }),
  ).join('\n');

  const css = `
.mal-mascot { --m-size: 84px; position: relative; display: inline-block; width: var(--m-size); height: calc(var(--m-size) * 130 / 120); }

/* La cara: el SVG de bloub enmarca la bola de radio 100 en un lienzo de 250. En una rejilla de 120×130 con la bola
   centrada en (60, 72) y radio 40, eso es una caja de 100×100 unidades con la esquina en (10, 22). */
.mal-mascot .m-body { position: absolute; left: 8.333%; top: 16.923%; width: 83.333%; height: 76.923%; }
.mal-mascot .m-face { display: none; width: 100%; height: 100%; pointer-events: none; user-select: none; }
${faces}

/* Flota suavemente, solo en vertical: girar o estirar la imagen la reescala y emborrona el borde.
   Los desplazamientos van en % de la caja de la cara. */
.mal-mascot .m-body { transform-origin: 50% 85%; animation: m-float 3.6s ease-in-out infinite; }
/* Episodio acabado: bota con aplastamiento */
.mal-mascot[data-mood='excited'] .m-body { animation: m-bounce 0.6s ease-in-out infinite; }

@keyframes m-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-4%); } }
@keyframes m-bounce {
  0%, 100% { transform: translateY(0) scale(1.08, 0.92); }
  45% { transform: translateY(-18%) scale(0.95, 1.05); }
  60% { transform: translateY(-16%) scale(1, 1); }
}

@media (prefers-reduced-motion: reduce) {
  .mal-mascot * { animation: none !important; }
}`;

  globalThis.MALMascot = { svg, css };
})();
