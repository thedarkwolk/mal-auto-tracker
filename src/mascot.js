// Mascota de MAL Auto (el bot): la bola de bloub (github.com/jeremy-prt/bloub, MIT), de un solo color.
// Cara según data-mood: idle (normal, también viendo un episodio) · excited (episodio acabado, bota).
// Color según data-tone: black (bola negra, para webs claras) · white (bola blanca, para webs oscuras).
// excited es una imagen (mascot/excited-<tone>.svg) que solo anima los ojos. idle va metida en la página como SVG
// (MALMascot.mount) para poder mover sus ojos: siguen al cursor. El bote del cuerpo va por CSS.
// Script clásico (no módulo) para usarlo en las webs.
(() => {
  if (globalThis.MALMascot) return;

  const IMG_MOODS = ['excited'];
  const TONES = ['black', 'white'];
  const url = (face) => globalThis.chrome?.runtime?.getURL?.(`mascot/${face}.svg`) || `../mascot/${face}.svg`;

  const svg = `<span class="m-body"><span class="m-face" data-face="idle"></span>${IMG_MOODS.flatMap((m) =>
    TONES.map((t) => `<img class="m-face" data-face="${m}-${t}" src="${url(`${m}-${t}`)}" alt="" draggable="false">`),
  ).join('')}</span>`;

  // Se ve la cara del humor y tono actuales; sin atributos, idle en negro. idle es una sola: el tono va por CSS.
  const faces = [
    `.mal-mascot${IMG_MOODS.map((m) => `:not([data-mood='${m}'])`).join('')} .m-face[data-face='idle'] { display: block; }`,
    ...IMG_MOODS.flatMap((m) =>
      TONES.map((t) => {
        const tone = t === 'black' ? `:not([data-tone='white'])` : `[data-tone='white']`;
        return `.mal-mascot[data-mood='${m}']${tone} .m-face[data-face='${m}-${t}'] { display: block; }`;
      }),
    ),
  ].join('\n');

  const css = `
.mal-mascot { --m-size: 84px; position: relative; display: inline-block; width: var(--m-size); height: calc(var(--m-size) * 130 / 120); }

/* La cara: el SVG de bloub enmarca la bola de radio 100 en un lienzo de 250. En una rejilla de 120×130 con la bola
   centrada en (60, 72) y radio 40, eso es una caja de 100×100 unidades con la esquina en (10, 22). */
.mal-mascot .m-body { position: absolute; left: 8.333%; top: 16.923%; width: 83.333%; height: 76.923%; }
.mal-mascot .m-face { display: none; width: 100%; height: 100%; pointer-events: none; user-select: none; }
${faces}

/* idle en línea: colores por tono y la mirada llevada hacia el cursor (--gx/--gy, en unidades del dibujo) */
.mal-mascot .m-face svg { display: block; width: 100%; height: 100%; }
.mal-mascot .m-ink { fill: #0a0a0c; }
.mal-mascot .m-paper { fill: #f4f4f5; }
.mal-mascot[data-tone='white'] .m-ink { fill: #f4f4f5; }
.mal-mascot[data-tone='white'] .m-paper { fill: #0a0a0c; }
.mal-mascot .m-gaze { transform: translate(var(--gx, 0px), var(--gy, 0px)); transition: transform 0.3s ease-out; }

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
  .mal-mascot * { animation: none !important; transition: none !important; }
}`;

  // ---------- idle en línea con mirada que sigue al cursor

  // Hasta dónde se alejan los ojos del centro al mirar, en unidades del dibujo (la bola mide 100 de radio; así
  // caben enteros en cualquier dirección), y a qué distancia del bot (px de pantalla) ya miran del todo al cursor.
  const GAZE_REACH = 45;
  const GAZE_FULL = 260;

  // Primer fotograma de la animación de cada ojo: matrix(a, b, c, d, x, y), donde (x, y) es su posición.
  const FIRST_FRAME = [
    /@keyframes oeil0\{0%\{transform:matrix\(([^)]+)\)/,
    /@keyframes oeil1\{0%\{transform:matrix\(([^)]+)\)/,
  ];

  // Promesa con el SVG de idle ya preparado y dónde tiene los ojos en reposo (el punto medio entre los dos;
  // Neutral los lleva arriba a la derecha). Compartida por todos los bots de la página.
  let idleSvg;
  function loadIdle() {
    idleSvg ??= fetch(url('idle-black')).then((r) => r.text()).then((text) => {
      const body = text.match(/<\/defs><path d="[^"]+"/)?.[0];
      const eyes = text.match(/<g clip-path="url\(#cuerpo\)" fill="#[0-9a-f]+">([\s\S]*?)<\/g>/);
      const at = FIRST_FRAME.map((re) => text.match(re)?.[1].split(',').map(Number));
      if (!body || !eyes || at.some((m) => m?.length !== 6)) throw new Error('SVG de idle inesperado');
      const markup = text
        .replace(body, `${body} class="m-ink"`)
        .replace(/(<\/defs><path d="[^"]+" class="m-ink") fill="#[0-9a-f]+"/, '$1')
        .replace(eyes[0], `<g clip-path="url(#cuerpo)" class="m-paper"><g class="m-gaze">${eyes[1]}</g></g>`)
        .replace(/ width="250" height="250"/, ' aria-hidden="true"');
      return { markup, rest: [(at[0][4] + at[1][4]) / 2, (at[0][5] + at[1][5]) / 2] };
    });
    return idleSvg;
  }

  // Mete la cara idle en el bot y hace que su mirada siga al cursor mientras está en idle.
  async function mount(bot) {
    const slot = bot.querySelector(".m-face[data-face='idle']");
    const { markup, rest } = await loadIdle();
    slot.innerHTML = markup;
    const gaze = slot.querySelector('.m-gaze');
    const face = bot.querySelector('.m-body');

    let x = null;
    let y = null;
    let frame = 0;
    const update = () => {
      frame = 0;
      // Solo mira al cursor en idle y con el panel cerrado (abierto, el bot está dentro del panel y no hace falta).
      const follow = !IMG_MOODS.includes(bot.dataset.mood) && bot.getAttribute('aria-expanded') !== 'true';
      // Sin seguir, los ojos se quedan donde los pone bloub. Siguiendo, su punto medio va hacia el cursor,
      // tanto más lejos del centro de la bola cuanto más lejos está el cursor.
      let gx = 0;
      let gy = 0;
      if (follow && x !== null) {
        const r = face.getBoundingClientRect();
        const dx = x - (r.left + r.width / 2);
        const dy = y - (r.top + r.height / 2);
        const d = Math.hypot(dx, dy) || 1;
        const k = (Math.min(d / GAZE_FULL, 1) * GAZE_REACH) / d;
        gx = dx * k - rest[0];
        gy = dy * k - rest[1];
      }
      gaze.style.setProperty('--gx', `${gx.toFixed(1)}px`);
      gaze.style.setProperty('--gy', `${gy.toFixed(1)}px`);
    };
    const schedule = () => (frame ||= requestAnimationFrame(update));
    addEventListener('mousemove', (e) => ((x = e.clientX), (y = e.clientY), schedule()), { passive: true });
    // El ratón se fue de la ventana (o a un iframe, como el reproductor): vuelve a mirar al frente.
    document.documentElement.addEventListener('mouseleave', () => ((x = y = null), schedule()));
    // Al abrir o cerrar el panel, o cambiar de humor, se recoloca la mirada sin esperar a que se mueva el ratón.
    new MutationObserver(schedule).observe(bot, { attributes: true, attributeFilter: ['aria-expanded', 'data-mood'] });
  }

  globalThis.MALMascot = { svg, css, mount };
})();
