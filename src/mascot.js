// Mascota de MAL Auto (el bot): la bola de bloub (github.com/jeremy-prt/bloub, MIT), de un solo color.
// Cara según data-mood: idle (normal, también viendo un episodio) · excited (episodio acabado, bota).
// Color según data-tone: black (bola negra, para webs claras) · white (bola blanca, para webs oscuras); y mientras
// se ve un aviso, el del aviso (data-alert: ok verde · info azul · warn ámbar · error rojo).
// Las dos caras (mascot/<cara>-black.svg) van metidas en la página como SVG (MALMascot.mount) para poder cambiarles
// el color por CSS y, en idle, mover los ojos: siguen al cursor. El bote del cuerpo va por CSS.
// Script clásico (no módulo) para usarlo en las webs.
(() => {
  if (globalThis.MALMascot) return;

  const FACES = ['idle', 'excited'];
  const url = (face) => globalThis.chrome?.runtime?.getURL?.(`mascot/${face}.svg`) || `../mascot/${face}.svg`;

  const svg = `<span class="m-body">${FACES.map((f) => `<span class="m-face" data-face="${f}"></span>`).join('')}</span>`;

  const css = `
.mal-mascot { --m-size: 84px; position: relative; display: inline-block; width: var(--m-size); height: calc(var(--m-size) * 130 / 120); }

/* La cara: el SVG de bloub enmarca la bola de radio 100 en un lienzo de 250. En una rejilla de 120×130 con la bola
   centrada en (60, 72) y radio 40, eso es una caja de 100×100 unidades con la esquina en (10, 22). */
.mal-mascot .m-body { position: absolute; left: 8.333%; top: 16.923%; width: 83.333%; height: 76.923%; }
.mal-mascot .m-face { display: none; width: 100%; height: 100%; pointer-events: none; user-select: none; }
.mal-mascot:not([data-mood='excited']) .m-face[data-face='idle'] { display: block; }
.mal-mascot[data-mood='excited'] .m-face[data-face='excited'] { display: block; }
.mal-mascot .m-face svg { display: block; width: 100%; height: 100%; }

/* Colores: bola (--m-ink) y ojos (--m-paper). Por tono de la web y, mientras hay un aviso, el suyo. */
.mal-mascot { --m-ink: #0a0a0c; --m-paper: #f4f4f5; }
.mal-mascot[data-tone='white'] { --m-ink: #f4f4f5; --m-paper: #0a0a0c; }
.mal-mascot[data-alert='ok'] { --m-ink: #3ecf8e; --m-paper: #f4f4f5; }
.mal-mascot[data-alert='info'] { --m-ink: #3b93f0; --m-paper: #f4f4f5; }
.mal-mascot[data-alert='warn'] { --m-ink: #f0b429; --m-paper: #f4f4f5; }
.mal-mascot[data-alert='error'] { --m-ink: #e8483f; --m-paper: #f4f4f5; }
.mal-mascot .m-ink { fill: var(--m-ink); transition: fill 0.4s var(--m-ease); }
.mal-mascot .m-paper { fill: var(--m-paper); transition: fill 0.4s var(--m-ease); }

/* Curva suave para todo lo de los ojos: arranca rápido y se posa despacio, sin rebote */
.mal-mascot { --m-ease: cubic-bezier(0.22, 0.61, 0.36, 1); }
/* idle: la mirada llevada hacia el cursor (--gx/--gy, en unidades del dibujo) */
.mal-mascot .m-gaze, .mal-mascot .m-eyes { transform-box: view-box; transform-origin: 0 0; }
.mal-mascot .m-gaze { transform: translate(var(--gx, 0px), var(--gy, 0px)); transition: transform 0.45s var(--m-ease); }
/* Al acercarse el cursor (--eo: 0 nada, 1 encima) los ojos de bloub crecen desde su punto medio (--cx/--cy)… */
.mal-mascot .m-eyes {
  --sx: calc(1 + 0.15 * var(--eo, 0));
  --sy: calc(1 + 0.3 * var(--eo, 0));
  transform: translate(var(--cx, 0px), var(--cy, 0px)) scale(var(--sx), var(--sy))
    translate(calc(-1 * var(--cx, 0px)), calc(-1 * var(--cy, 0px)));
  transition: transform 0.45s var(--m-ease), opacity 0.4s var(--m-ease);
}
/* …y ya cerca (data-wide) se funden con los ojos bien abiertos de bloub: los de siempre siguen creciendo hacia
   su tamaño mientras se desvanecen, y los abiertos aparecen desde algo más pequeños. */
.mal-mascot .m-gaze[data-wide] .m-eyes { --sx: 1.35; --sy: 1.6; opacity: 0; }
.mal-mascot .m-wide {
  opacity: 0;
  transform: scale(0.7, 0.6);
  transform-box: fill-box;
  transform-origin: center;
  transition: transform 0.45s var(--m-ease), opacity 0.4s var(--m-ease);
}
.mal-mascot .m-gaze[data-wide] .m-wide { opacity: 1; transform: scale(1); }
.mal-mascot .m-wide .m-blink { transform-box: fill-box; transform-origin: center; animation: m-blink 4.2s infinite; }
@keyframes m-blink { 0%, 93%, 100% { transform: scaleY(1); } 96% { transform: scaleY(0.12); } }

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

  // ---------- Caras en línea

  // Hasta dónde se alejan los ojos del centro al mirar, en unidades del dibujo (la bola mide 100 de radio; así
  // caben enteros en cualquier dirección), y a qué distancia del bot (px de pantalla) ya miran del todo al cursor.
  const GAZE_REACH = 45;
  const GAZE_FULL = 260;
  // Con el cursor a menos de EYES_FAR px del centro del bot empieza a abrir los ojos; a EYES_NEAR, del todo.
  const EYES_FAR = 160;
  const EYES_NEAR = 50;
  // Ojos bien abiertos de cerca: los de la cara de ojos abiertos de bloub (una cápsula de 40×60 por ojo, cada una con
  // su matrix). Sus posiciones van relativas al punto medio entre los dos, que se lleva al de los ojos en reposo.
  // Aparecen con --eo por encima de WIDE_ON y se van por debajo de WIDE_OFF (el hueco evita que parpadeen en el límite).
  const WIDE_EYE = 'M-20 -10A20 20 0 0 1 0 -30L0 -30A20 20 0 0 1 20 -10L20 10A20 20 0 0 1 0 30L0 30A20 20 0 0 1 -20 10Z';
  const WIDE_AT = [
    [0.96, 0.16, -0.05, 0.92, -28.38, 36.16],
    [0.91, -0.12, -0.05, 0.92, 41.42, 37.52],
  ];
  const WIDE_ON = 0.6;
  const WIDE_OFF = 0.4;

  // Primer fotograma de la animación de cada ojo: matrix(a, b, c, d, x, y), donde (x, y) es su posición.
  const FIRST_FRAME = [
    /@keyframes oeil0\{0%\{transform:matrix\(([^)]+)\)/,
    /@keyframes oeil1\{0%\{transform:matrix\(([^)]+)\)/,
  ];

  // Prepara el SVG de una cara para meterlo en la página: la bola y los ojos pasan a colorearse por CSS (m-ink,
  // m-paper) y, en idle, los ojos se envuelven para poder llevarlos hacia el cursor y abrirlos. Como las dos caras
  // conviven en la misma página, los nombres que repiten (el recorte "cuerpo" y las animaciones "oeil") llevan delante
  // el de la cara. Devuelve también, para idle, dónde tiene los ojos en reposo (el punto medio entre los dos;
  // Neutral los lleva arriba a la derecha).
  function prepareFace(face, text) {
    const body = text.match(/<\/defs><path d="[^"]+"/)?.[0];
    const eyes = text.match(/<g clip-path="url\(#cuerpo\)" fill="#[0-9a-f]+">([\s\S]*?)<\/g>/);
    const at = FIRST_FRAME.map((re) => text.match(re)?.[1].split(',').map(Number));
    if (!body || !eyes || at.some((m) => m?.length !== 6)) throw new Error(`SVG de ${face} inesperado`);
    const rest = [(at[0][4] + at[1][4]) / 2, (at[0][5] + at[1][5]) / 2];
    let inner = eyes[1];
    if (face === 'idle') {
      // Los ojos abiertos, con su mismo punto medio que los de reposo. Cada uno en su <g> para el parpadeo (una
      // animación CSS de transform pisaría la matrix del propio ojo).
      const mid = [(WIDE_AT[0][4] + WIDE_AT[1][4]) / 2, (WIDE_AT[0][5] + WIDE_AT[1][5]) / 2];
      const wide = WIDE_AT.map(([a, b, c, d, x, y]) => {
        const m = [a, b, c, d, (x - mid[0] + rest[0]).toFixed(2), (y - mid[1] + rest[1]).toFixed(2)];
        return `<g class="m-blink"><path d="${WIDE_EYE}" transform="matrix(${m.join(',')})"/></g>`;
      }).join('');
      inner = `<g class="m-gaze"><g class="m-eyes">${eyes[1]}</g><g class="m-wide">${wide}</g></g>`;
    }
    const markup = text
      .replace(body, `${body} class="m-ink"`)
      .replace(/(<\/defs><path d="[^"]+" class="m-ink") fill="#[0-9a-f]+"/, '$1')
      .replace(eyes[0], () => `<g clip-path="url(#cuerpo)" class="m-paper">${inner}</g>`)
      .replace(/ width="250" height="250"/, ' aria-hidden="true"')
      .replace(/\bcuerpo\b/g, `${face}-cuerpo`)
      .replace(/\boeil(\d)/g, `${face}-oeil$1`);
    return { markup, rest };
  }

  // Promesas con cada cara ya preparada, compartidas por todos los bots de la página.
  const faces = {};
  const loadFace = (face) =>
    (faces[face] ??= fetch(url(`${face}-black`)).then((r) => r.text()).then((text) => prepareFace(face, text)));

  // Mete las caras en el bot y hace que, en idle, su mirada siga al cursor.
  async function mount(bot) {
    const [idle, excited] = await Promise.all(FACES.map(loadFace));
    bot.querySelector(".m-face[data-face='excited']").innerHTML = excited.markup;
    const slot = bot.querySelector(".m-face[data-face='idle']");
    slot.innerHTML = idle.markup;
    const { rest } = idle;
    const gaze = slot.querySelector('.m-gaze');
    const face = bot.querySelector('.m-body');
    gaze.style.setProperty('--cx', `${rest[0]}px`);
    gaze.style.setProperty('--cy', `${rest[1]}px`);

    let x = null;
    let y = null;
    let frame = 0;
    const update = () => {
      frame = 0;
      // Solo mira al cursor en idle y con el panel cerrado (abierto, el bot está dentro del panel y no hace falta).
      const follow = bot.dataset.mood !== 'excited' && bot.getAttribute('aria-expanded') !== 'true';
      // Sin seguir, los ojos se quedan donde los pone bloub. Siguiendo, su punto medio va hacia el cursor,
      // tanto más lejos del centro de la bola cuanto más lejos está el cursor.
      // Y cuanto más cerca está el cursor, más abre los ojos.
      let gx = 0;
      let gy = 0;
      let open = 0;
      if (follow && x !== null) {
        const r = face.getBoundingClientRect();
        const dx = x - (r.left + r.width / 2);
        const dy = y - (r.top + r.height / 2);
        const d = Math.hypot(dx, dy) || 1;
        const k = (Math.min(d / GAZE_FULL, 1) * GAZE_REACH) / d;
        gx = dx * k - rest[0];
        gy = dy * k - rest[1];
        open = Math.min(1, Math.max(0, (EYES_FAR - d) / (EYES_FAR - EYES_NEAR)));
      }
      gaze.style.setProperty('--gx', `${gx.toFixed(1)}px`);
      gaze.style.setProperty('--gy', `${gy.toFixed(1)}px`);
      gaze.style.setProperty('--eo', open.toFixed(2));
      gaze.toggleAttribute('data-wide', open > (gaze.hasAttribute('data-wide') ? WIDE_OFF : WIDE_ON));
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
