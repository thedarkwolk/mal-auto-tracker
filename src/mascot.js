// Mascota de MAL Auto (el bot): la bola de bloub (github.com/jeremy-prt/bloub, MIT), de un solo color.
// Color según data-tone: black (bola negra, para webs claras) · white (bola blanca, para webs oscuras); y mientras
// se ve un aviso, el del aviso (data-alert: ok verde · info azul · warn ámbar · error rojo) y su cara (info curiosa,
// warn desconfiada, error confusa; ok la normal). Cada aviso nuevo (data-notice, un número que cambia con cada uno)
// le hace dar una vuelta, aunque sea del mismo tipo que el anterior, y al acabar da otra para volver a la cara normal.
// La bola (mascot/idle-black.svg) va metida en la página como SVG (MALMascot.mount) para poder cambiarle el color
// por CSS. Los ojos se dibujan aquí (mount), con el modelo de bloub, para que sigan al cursor, se abran al acercarse,
// parpadeen y pongan caras. El flote del cuerpo va por CSS.
// Script clásico (no módulo) para usarlo en las webs.
(() => {
  if (globalThis.MALMascot) return;

  const FACE = 'mascot/idle-black.svg';
  const url = globalThis.chrome?.runtime?.getURL?.(FACE) || `../${FACE}`;

  const svg = '<span class="m-body"><span class="m-face"></span></span>';

  // La vuelta de cuando sale un aviso (ms): la cabeza gira entera y el color cambia a la vez.
  const SPIN_MS = 800;

  const css = `
.mal-mascot { --m-size: 84px; position: relative; display: inline-block; width: var(--m-size); height: calc(var(--m-size) * 130 / 120); }

/* La cara: el SVG de bloub enmarca la bola de radio 100 en un lienzo de 250. En una rejilla de 120×130 con la bola
   centrada en (60, 72) y radio 40, eso es una caja de 100×100 unidades con la esquina en (10, 22). */
.mal-mascot .m-body { position: absolute; left: 8.333%; top: 16.923%; width: 83.333%; height: 76.923%; }
.mal-mascot .m-face { display: block; width: 100%; height: 100%; pointer-events: none; user-select: none; }
.mal-mascot .m-face svg { display: block; width: 100%; height: 100%; }

/* Colores: bola (--m-ink) y ojos (--m-paper). Por tono de la web (--m-tone-*) y, mientras hay un aviso, el suyo. */
.mal-mascot { --m-tone-ink: #0a0a0c; --m-tone-paper: #f4f4f5; --m-ink: var(--m-tone-ink); --m-paper: var(--m-tone-paper); }
.mal-mascot[data-tone='white'] { --m-tone-ink: #f4f4f5; --m-tone-paper: #0a0a0c; }
.mal-mascot[data-alert='ok'] { --m-ink: #3ecf8e; --m-paper: #f4f4f5; }
.mal-mascot[data-alert='info'] { --m-ink: #3b93f0; --m-paper: #f4f4f5; }
.mal-mascot[data-alert='warn'] { --m-ink: #f0b429; --m-paper: #f4f4f5; }
.mal-mascot[data-alert='error'] { --m-ink: #e8483f; --m-paper: #f4f4f5; }
/* Los cambios de color (de tono al abrir o cerrar el panel, o de la web, o a un aviso sin cuenta atrás) van a la vez
   que la vuelta y con su curva */
.mal-mascot .m-ink { fill: var(--m-ink); transition: fill ${SPIN_MS}ms cubic-bezier(0.65, 0, 0.35, 1); }
.mal-mascot .m-paper { fill: var(--m-paper); transition: fill ${SPIN_MS}ms cubic-bezier(0.65, 0, 0.35, 1); }
/* Los avisos de las webs (data-fade; lo pone common.js) van con animaciones y no con la transición: del color que tiene
   la bola al salir (--m-from-*; si aún se apagaba del anterior, no es el normal) al del aviso durante la vuelta, y
   después hace de cuenta atrás, apagándose hasta el normal en lo que queda de aviso (--m-fade). Al acabar ya tiene el
   normal, así que quitar el aviso no cambia nada. El borde del aviso lleva las mismas. */
.mal-mascot[data-alert][data-fade] .m-ink {
  animation: m-in-ink ${SPIN_MS}ms cubic-bezier(0.65, 0, 0.35, 1), m-fade-ink var(--m-fade) linear ${SPIN_MS}ms forwards;
}
.mal-mascot[data-alert][data-fade] .m-paper {
  animation: m-in-paper ${SPIN_MS}ms cubic-bezier(0.65, 0, 0.35, 1), m-fade-paper var(--m-fade) linear ${SPIN_MS}ms forwards;
}
@keyframes m-in-ink { from { fill: var(--m-from-ink, var(--m-tone-ink)); } to { fill: var(--m-ink); } }
@keyframes m-in-paper { from { fill: var(--m-from-paper, var(--m-tone-paper)); } to { fill: var(--m-paper); } }
@keyframes m-fade-ink { from { fill: var(--m-ink); } to { fill: var(--m-tone-ink); } }
@keyframes m-fade-paper { from { fill: var(--m-paper); } to { fill: var(--m-tone-paper); } }
/* Al acabar (data-unfade) vuelve al color normal durante la vuelta de regreso, desde el que tenga entonces: si el aviso
   se cerró antes de tiempo, aún no se había apagado del todo. */
.mal-mascot[data-unfade]:not([data-alert]) .m-ink { animation: m-out-ink ${SPIN_MS}ms cubic-bezier(0.65, 0, 0.35, 1) forwards; }
.mal-mascot[data-unfade]:not([data-alert]) .m-paper { animation: m-out-paper ${SPIN_MS}ms cubic-bezier(0.65, 0, 0.35, 1) forwards; }
@keyframes m-out-ink { from { fill: var(--m-from-ink); } to { fill: var(--m-tone-ink); } }
@keyframes m-out-paper { from { fill: var(--m-from-paper); } to { fill: var(--m-tone-paper); } }

/* Flota suavemente, solo en vertical: girar o estirar la imagen la reescala y emborrona el borde.
   Los desplazamientos van en % de la caja de la cara. */
.mal-mascot .m-body { transform-origin: 50% 85%; animation: m-float 3.6s ease-in-out infinite; }

@keyframes m-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-4%); } }

@media (prefers-reduced-motion: reduce) {
  .mal-mascot * { animation: none !important; transition: none !important; }
}`;

  // ---------- Caras en línea

  // Prepara el SVG de la cara para meterlo en la página: la bola y los ojos pasan a colorearse por CSS (m-ink,
  // m-paper), y los ojos de bloub (en perspectiva, mirando arriba a la derecha, con su animación) se cambian por dos
  // vacíos que dibuja mount. El recorte "cuerpo" se renombra para no chocar con ids de la web.
  function prepareFace(text) {
    const body = text.match(/<\/defs><path d="[^"]+"/)?.[0];
    const eyes = text.match(/<g clip-path="url\(#cuerpo\)" fill="#[0-9a-f]+">[\s\S]*?<\/g>/)?.[0];
    if (!body || !eyes) throw new Error('SVG del bot inesperado');
    return text
      .replace(body, `${body} class="m-ink"`)
      .replace(/(<\/defs><path d="[^"]+" class="m-ink") fill="#[0-9a-f]+"/, '$1')
      .replace(eyes, '<g clip-path="url(#cuerpo)" class="m-paper"><rect class="m-eye"/><rect class="m-eye"/></g>')
      .replace(/<style>[\s\S]*?<\/style>/, '')
      .replace(/ width="250" height="250"/, ' aria-hidden="true"')
      .replace(/\bcuerpo\b/g, 'mal-mascot-cuerpo');
  }

  // La cara ya preparada, compartida por todos los bots de la página.
  let face;
  const loadFace = () => (face ??= fetch(url).then((r) => r.text()).then(prepareFace));

  // ---------- Ojos
  // El modelo de bloub (src/bot/face.ts y expressions.ts): los ojos son dos cápsulas pintadas sobre una esfera (la bola,
  // de radio 100 en el dibujo). La cabeza tiene una orientación (yaw: a la derecha, pitch: arriba, roll: ladeada, en
  // grados) y cada ojo se separa `split` grados de la dirección de la mirada; los dos toman el plano tangente de la
  // esfera en su punto, proyectado de frente, así que la perspectiva cambia con la dirección y al frente son iguales.
  // Cada ojo tiene además su tamaño (w, h, en radios de bola), su inclinación propia (tilt, grados, positivo: la parte
  // de arriba hacia la derecha) y lo abierto que está (open, 1–0, el párpado: aplasta en vertical, como el parpadeo).

  const BALL = [0.19, 0.33]; // centro de la bola en el dibujo
  const RADIUS = 100;
  // Hasta dónde gira la mirada siguiendo al cursor (grados) y a qué distancia del bot (px de pantalla) gira del todo.
  const GAZE_MAX = 38;
  const GAZE_FULL = 260;
  // Con el cursor a menos de EYES_FAR px del centro del bot empieza a abrir los ojos; a EYES_NEAR, del todo.
  const EYES_FAR = 160;
  const EYES_NEAR = 50;
  // Altura de la mirada al frente (grados, un poco arriba) y separación de los ojos (la de bloub).
  const EYE_PITCH = 5.7;
  const EYE_SPLIT = 15.46;
  // Tamaño de la cápsula (ancho, alto): en reposo, la de bloub; abiertos del todo, más grande y redonda.
  const EYE_REST = [0.186, 0.412];
  const EYE_OPEN = [0.34, 0.54];
  // Muelle de todo lo de la cara: rigidez y amortiguación (algo por debajo de la crítica: se pasa un poco).
  const STIFF = 120;
  const DAMP = 17;
  // Parpadeo: lo que dura y cada cuánto (al azar entre los dos, y a veces doble).
  const BLINK_MS = 180;
  const BLINK_EVERY = [2500, 6500];

  // Caras de bloub, tal cual (ojo izquierdo, derecho: [w, h, tilt]). Mientras se ven no siguen al cursor.
  const EXPRESSIONS = {
    // la cabeza ladeada es lo que hace la curiosidad
    curious: { yaw: 16, pitch: -9, roll: -15, split: 16.5, eyes: [[0.24, 0.46, -8], [0.2, 0.38, -8]] },
    // un ojo bastante más cerrado que el otro
    suspicious: { yaw: 12, pitch: 6, roll: -6, split: 16, eyes: [[0.21, 0.4, 0], [0.22, 0.15, 0]] },
    // desparejado en tamaño y en inclinación
    confused: { yaw: -14, pitch: 3, roll: 8, split: 16.5, eyes: [[0.2, 0.44, -18], [0.28, 0.17, 14]] },
  };
  // La cara de cada aviso (data-alert); data-face la fuerza (el banco de pruebas): una de EXPRESSIONS o neutral.
  const ALERT_FACE = { info: 'curious', warn: 'suspicious', error: 'confused' };

  const rad = (d) => (d * Math.PI) / 180;
  const clamp = (v) => Math.min(1, Math.max(0, v));

  // Gira dos vectores de una base ortonormal dentro de su plano.
  function spin(u, v, angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return [u.map((x, i) => x * c + v[i] * s), v.map((x, i) => x * c - u[i] * s)];
  }

  // Dónde cae cada ojo (x, y en radios de bola), su base en pantalla (a b c d de matrix) y si mira hacia nosotros
  // (depth > 0). Ejes de pantalla: x a la derecha, y hacia abajo, z hacia quien mira.
  function eyePoses({ yaw, pitch, roll, split }) {
    let f = [0, 0, 1];
    let right = [1, 0, 0];
    let down = [0, 1, 0];
    [f, right] = spin(f, right, rad(yaw));
    [down, f] = spin(down, f, rad(pitch));
    [right, down] = spin(right, down, rad(roll));
    return [-1, 1].map((side) => {
      const [ef, er] = spin(f, right, rad(split * side));
      return { x: ef[0], y: ef[1], a: er[0], b: er[1], c: down[0], d: down[1], depth: ef[2] };
    });
  }

  // La cara aplanada en números, para llevar cada uno con su muelle.
  const flat = ({ yaw, pitch, roll, split, eyes }) => ({
    yaw, pitch, roll, split,
    ...Object.fromEntries(eyes.flatMap(([w, h, tilt, open = 1], i) => [[`w${i}`, w], [`h${i}`, h], [`t${i}`, tilt], [`o${i}`, open]])),
  });

  // La cara neutral con el cursor a (dx, dy) px del centro del bot: lo mira y, cuanto más cerca, más abre los ojos.
  function pose(dx, dy) {
    const d = Math.hypot(dx, dy) || 1;
    const s = Math.min(d / GAZE_FULL, 1) * Math.sin(rad(GAZE_MAX));
    const down = Math.asin((dy / d) * s);
    const yaw = (Math.asin(((dx / d) * s) / Math.cos(down)) * 180) / Math.PI;
    const near = clamp((EYES_FAR - d) / (EYES_FAR - EYES_NEAR));
    return neutral(yaw, (-down * 180) / Math.PI, near);
  }
  function neutral(yaw = 0, pitch = 0, near = 0) {
    const e = near * near * (3 - 2 * near); // suave al empezar y al acabar
    const eye = [EYE_REST[0] + (EYE_OPEN[0] - EYE_REST[0]) * e, EYE_REST[1] + (EYE_OPEN[1] - EYE_REST[1]) * e, 0];
    return { yaw, pitch: pitch + EYE_PITCH, roll: 0, split: EYE_SPLIT, eyes: [eye, eye] };
  }
  // Con el panel abierto mira hacia él, arriba a la derecha: la pose de reposo de bloub (con su cabeza ladeada).
  const PANEL_LOOK = { ...neutral(28.5, 28.6 - EYE_PITCH), roll: -13 };
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

  // Mete la cara en el bot y pone en marcha los ojos. Devuelve su estado (now: cómo está; target: a dónde va) y, para
  // el banco de pruebas, pin(pose) para fijar la cara (null para volver a seguir al cursor) y blink().
  async function mount(bot) {
    const slot = bot.querySelector('.m-face');
    slot.innerHTML = await loadFace();
    const eyes = [...slot.querySelectorAll('.m-eye')];
    const body = bot.querySelector('.m-body');
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');

    const target = flat(neutral());
    const now = { ...target };
    const speed = Object.fromEntries(Object.keys(now).map((k) => [k, 0]));
    let x = null;
    let y = null;
    let pinned = null;
    let shown = 'neutral';
    let dirty = true;
    let shownAlert = '';
    let shownNotice;
    let shownOpen = bot.getAttribute('aria-expanded') === 'true';
    let lid = null; // cómo va el parpadeo en curso (0–1), o null
    let turn = null; // cómo va la vuelta en curso (0–1), o null
    let next = null; // la cara que se pone a media vuelta
    let frame = 0;
    let last = 0;

    // A dónde va la cara: la del aviso si lo hay; si no, con el panel abierto hacia él y, cerrado, hacia el cursor.
    // Se calcula al mover el ratón y no en cada fotograma: con el flote, la caja de la cara nunca se está quieta.
    function aim() {
      const alert = bot.dataset.alert || '';
      const name = bot.dataset.face || ALERT_FACE[alert] || 'neutral';
      let face = pinned || EXPRESSIONS[name];
      if (!face && bot.getAttribute('aria-expanded') === 'true') face = PANEL_LOOK;
      else if (!face && x !== null) {
        const r = body.getBoundingClientRect();
        face = pose(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
      }
      face ||= neutral();
      // Sale un aviso nuevo, acaba, se abre o se cierra el panel (o se fuerza otra cara): da la vuelta y cambia de cara a media vuelta, con los ojos
      // detrás de la bola. Si cambia sin vuelta, un parpadeo (como bloub) disimula el cambio.
      const fresh = alert && (alert !== shownAlert || bot.dataset.notice !== shownNotice);
      const over = !alert && shownAlert && !bot.dataset.face;
      const open = bot.getAttribute('aria-expanded') === 'true';
      const spin = !pinned && !reduced.matches && (fresh || over || open !== shownOpen || (bot.dataset.face && name !== shown));
      shownOpen = open;
      if (spin) turn = 0;
      if (turn !== null && turn < 0.5) next = face;
      else Object.assign(target, flat(face));
      if (name !== shown && !pinned && turn === null) blink();
      shown = name;
      shownAlert = alert;
      shownNotice = bot.dataset.notice;
    }

    function draw() {
      // El parpadeo cierra rápido y abre algo más despacio
      const blinking = lid === null ? 1 : lid < 0.45 ? 1 - lid / 0.45 : (lid - 0.45) / 0.55;
      // La vuelta: de -360° a 0 (el mismo ángulo), así que los ojos acaban donde los pone la cara
      const spun = turn === null ? 0 : 360 * (1 - easeInOut(turn));
      eyePoses({ ...now, yaw: now.yaw - spun }).forEach((e, i) => {
        const [w, h, tilt, open] = [now[`w${i}`], now[`h${i}`], now[`t${i}`], now[`o${i}`]];
        const [c, s] = [Math.cos(rad(tilt)), Math.sin(rad(tilt))];
        // Párpado y parpadeo aplastan en vertical en pantalla, alrededor del centro del ojo
        const k = 0.06 + 0.94 * clamp(Math.min(blinking, open));
        const m = [e.a * c + e.c * s, (e.b * c + e.d * s) * k, -e.a * s + e.c * c, (-e.b * s + e.d * c) * k];
        m.push(BALL[0] + e.x * RADIUS, BALL[1] + e.y * RADIUS);
        const eye = eyes[i];
        eye.setAttribute('transform', `matrix(${m.map((v) => v.toFixed(3)).join(' ')})`);
        const [pw, ph] = [Math.max(w, 0.001) * RADIUS, Math.max(h, 0.001) * RADIUS];
        const r = (Math.min(pw, ph) / 2).toFixed(2);
        for (const [key, v] of [['x', -pw / 2], ['y', -ph / 2], ['width', pw], ['height', ph]]) eye.setAttribute(key, v.toFixed(2));
        eye.setAttribute('rx', r);
        eye.setAttribute('ry', r);
        eye.setAttribute('opacity', clamp(e.depth / 0.12).toFixed(2)); // de canto del todo, desaparece
      });
    }

    // Un fotograma: los muelles hacia la cara de destino y el parpadeo. Se para solo cuando todo está quieto.
    function tick(t) {
      frame = 0;
      const dt = (last ? Math.min((t - last) / 1000, 1 / 30) : 1 / 60) * api.speed;
      last = t;
      if (dirty) aim();
      dirty = false;
      let busy = false;
      for (const k of Object.keys(now)) {
        if (reduced.matches) {
          now[k] = target[k];
          speed[k] = 0;
          continue;
        }
        speed[k] += (STIFF * (target[k] - now[k]) - DAMP * speed[k]) * dt;
        now[k] += speed[k] * dt;
        if (Math.abs(target[k] - now[k]) > 1e-3 || Math.abs(speed[k]) > 1e-3) busy = true;
        else (now[k] = target[k]), (speed[k] = 0);
      }
      if (turn !== null) {
        turn += (dt * 1000) / SPIN_MS;
        // A media vuelta los ojos están detrás: la cara nueva se pone de golpe, sin que se vea
        if (turn >= 0.5 && next) {
          Object.assign(target, flat(next));
          Object.assign(now, target);
          for (const k of Object.keys(speed)) speed[k] = 0;
          next = null;
        }
        if (turn >= 1) turn = null;
        else busy = true;
      }
      if (lid !== null) {
        lid += (dt * 1000) / BLINK_MS;
        if (lid >= 1) lid = null;
        else busy = true;
      }
      draw();
      if (busy || api.speed === 0) frame ||= requestAnimationFrame(tick);
      else last = 0;
    }
    const wake = () => (frame ||= requestAnimationFrame(tick));
    const update = () => ((dirty = true), wake());
    function blink() {
      if (reduced.matches) return;
      lid = 0;
      wake();
    }

    // Parpadea cada poco, al azar; si no se ve (pestaña oculta o bot fuera de la página), se lo salta.
    (function later() {
      const [a, b] = BLINK_EVERY;
      setTimeout(() => {
        if (!document.hidden && bot.isConnected) {
          blink();
          if (Math.random() < 0.15) setTimeout(blink, BLINK_MS + 90);
        }
        later();
      }, a + Math.random() * (b - a));
    })();

    addEventListener('mousemove', (e) => ((x = e.clientX), (y = e.clientY), update()), { passive: true });
    // El ratón se fue de la ventana (o a un iframe, como el reproductor): vuelve a mirar al frente.
    document.documentElement.addEventListener('mouseleave', () => ((x = y = null), update()));
    // Al abrir o cerrar el panel, o salir un aviso, se recoloca la cara sin esperar a que se mueva el ratón.
    const attributeFilter = ['aria-expanded', 'data-alert', 'data-face', 'data-notice'];
    new MutationObserver(update).observe(bot, { attributes: true, attributeFilter });
    draw();

    return { now, target, blink, pin: (p) => ((pinned = p), update()) };
  }

  // speed: velocidad de la cara (el banco de pruebas la baja para verla a cámara lenta); tuning, sus ajustes.
  const tuning = { GAZE_MAX, GAZE_FULL, EYES_FAR, EYES_NEAR, EYE_PITCH, EYE_SPLIT, SPIN_MS };
  const api = { svg, css, mount, pose, neutral, expressions: Object.keys(EXPRESSIONS), tuning, speed: 1 };
  globalThis.MALMascot = api;
})();
