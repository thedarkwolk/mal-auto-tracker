// Banco de pruebas del bot: todas sus caras, tonos, avisos y transiciones, más un cursor simulado para repetir
// siempre el mismo recorrido y ver si la mirada responde igual. Usa el bot de verdad (src/mascot.js).
// Se abre como página de la extensión (chrome-extension://<id>/dev/mascot.html) o con un servidor estático en la
// raíz del repo (desde file:// no puede cargar las caras).
(() => {
  const M = globalThis.MALMascot;
  const { svg, css, mount, pose, neutral, expressions, tuning: T } = M;
  document.head.append(Object.assign(document.createElement('style'), { textContent: css }));

  const $ = (id) => document.getElementById(id);
  const deg = (d) => `${d.toFixed(1)}°`;

  // Un bot sin montar, con estos atributos
  function make(attrs = {}) {
    const bot = document.createElement('div');
    bot.className = 'mal-mascot';
    bot.innerHTML = svg;
    for (const [k, v] of Object.entries(attrs)) bot.setAttribute(k, v);
    return bot;
  }

  function hop(bot) {
    bot.classList.remove('hop');
    void bot.offsetWidth;
    bot.classList.add('hop');
  }

  // ---------- Cursor: el real o uno simulado
  // Simulado, el ratón de verdad no les llega a los bots (se corta en la captura) y en su lugar se les manda un
  // mousemove sintético con la posición del recorrido, relativa al centro de la bola del laboratorio.

  let mode = 'real';
  let real = null; // última posición del ratón de verdad
  const sim = { dx: 140, dy: 60 };
  let sent = '';
  const intercept = (e) => {
    if (!e.isTrusted) return;
    real = e.type === 'mousemove' ? { x: e.clientX, y: e.clientY } : null;
    if (mode !== 'real') e.stopImmediatePropagation();
  };
  addEventListener('mousemove', intercept, true);
  addEventListener('mouseleave', intercept, true);

  const stage = $('stage');
  const cursor = $('cursor');
  for (const radio of document.querySelectorAll('[name=mode]')) {
    radio.onchange = () => {
      mode = radio.value;
      stage.dataset.mode = mode;
      cursor.hidden = mode === 'real';
      sent = '';
      // Al volver al ratón de verdad, que miren a donde está
      if (mode === 'real' && real) dispatchEvent(new MouseEvent('mousemove', { clientX: real.x, clientY: real.y }));
    };
  }
  stage.addEventListener('pointerdown', (e) => {
    if (mode !== 'drag') return;
    stage.setPointerCapture(e.pointerId);
    drag(e);
  });
  stage.addEventListener('pointermove', (e) => mode === 'drag' && stage.hasPointerCapture(e.pointerId) && drag(e));
  function drag(e) {
    const c = center();
    sim.dx = e.clientX - c.x;
    sim.dy = e.clientY - c.y;
  }

  // Controles con su valor al lado
  const slider = (id, show) => {
    const input = $(id);
    const paint = () => ($(`${id}-out`).textContent = show(Number(input.value)));
    input.addEventListener('input', paint);
    paint();
    return () => Number(input.value);
  };
  const radius = slider('radius', (v) => `${v} px`);
  const angle = slider('angle', (v) => `${v}°`);
  const speed = slider('speed', (v) => `${v.toFixed(1)}×`);

  // ---------- Laboratorio

  const lab = make({ 'data-tone': 'white' });
  $('lab-slot').append(lab);

  function applyLab() {
    lab.style.setProperty('--m-size', `${$('size').value}px`);
    lab.dataset.tone = $('tone').value;
    for (const [id, key] of [['alert', 'alert'], ['face', 'face']]) {
      if ($(id).value) lab.dataset[key] = $(id).value;
      else delete lab.dataset[key];
    }
    lab.setAttribute('aria-expanded', String($('expanded').checked));
    stage.classList.toggle('light', lab.dataset.tone === 'black');
    stage.classList.toggle('dark', lab.dataset.tone !== 'black');
    sent = ''; // el centro de la bola cambia con el tamaño
  }
  for (const id of ['size', 'tone', 'alert', 'face', 'expanded']) $(id).onchange = applyLab;
  $('hop').onclick = () => hop(lab);
  let labEyes = null; // lo que devuelve mount: el estado de sus ojos
  $('blink').onclick = () => labEyes?.blink();
  applyLab();

  // Centro de la bola del laboratorio en pantalla: en la rejilla de 120×130 del bot está en (60, 72). Se toma la
  // caja del bot y no la de la cara para que el bote no lo mueva (el bot de verdad sí lo mide con el bote).
  function center() {
    const r = lab.getBoundingClientRect();
    return { x: r.left + (r.width * 60) / 120, y: r.top + (r.height * 72) / 130 };
  }

  $('ring-full').style.width = $('ring-full').style.height = `${T.GAZE_FULL * 2}px`;
  $('ring-far').style.width = $('ring-far').style.height = `${T.EYES_FAR * 2}px`;
  $('ring-near').style.width = $('ring-near').style.height = `${T.EYES_NEAR * 2}px`;
  $('tuning').textContent =
    `GAZE_MAX ${T.GAZE_MAX}° · GAZE_FULL ${T.GAZE_FULL}px · EYES_FAR ${T.EYES_FAR}px · ` +
    `EYES_NEAR ${T.EYES_NEAR}px · EYE_PITCH ${T.EYE_PITCH}° · EYE_SPLIT ${T.EYE_SPLIT}°`;

  // ---------- Línea de tiempo: alto del ojo, mirada y distancia de los últimos segundos

  const SPAN = 8000;
  const samples = [];
  const canvas = $('timeline');
  const ctx = canvas.getContext('2d');
  function plot(now) {
    const dpr = devicePixelRatio || 1;
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) Object.assign(canvas, { width: w, height: h });
    ctx.clearRect(0, 0, w, h);
    const pad = 6 * dpr;
    const x = (t) => w - ((now - t) / SPAN) * w;
    const y = (v) => h - pad - v * (h - 2 * pad);
    ctx.setLineDash([3 * dpr, 4 * dpr]);
    ctx.strokeStyle = '#ffffff30';
    ctx.lineWidth = dpr;
    ctx.beginPath();
    ctx.moveTo(0, y(0.5));
    ctx.lineTo(w, y(0.5));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 2 * dpr;
    for (const [key, color] of [['d', '#6b6b75'], ['lon', '#3b93f0'], ['open', '#f4f4f5']]) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      samples.forEach((s, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, x(s.t), y(s[key])));
      ctx.stroke();
    }
  }

  // ---------- Cada fotograma: recorrido, anillos, lecturas y velocidad de las animaciones

  let before = performance.now();
  let phase = 0;
  const rings = $('rings');
  const readout = $('readout');

  function frame(now) {
    const dt = Math.min(0.1, (now - before) / 1000);
    before = now;
    phase += dt * speed();

    if (mode === 'orbit') {
      const a = (phase / 8) * 2 * Math.PI; // una vuelta cada 8 s a 1×
      sim.dx = radius() * Math.cos(a);
      sim.dy = radius() * Math.sin(a);
    } else if (mode === 'approach') {
      const p = (phase / 10) % 1; // ida y vuelta cada 10 s a 1×
      const d = (T.GAZE_FULL + 40) * Math.abs(1 - 2 * p);
      const a = (angle() * Math.PI) / 180;
      sim.dx = d * Math.cos(a);
      sim.dy = d * Math.sin(a);
    }

    const c = center();
    const box = stage.getBoundingClientRect();
    rings.style.left = `${c.x - box.left}px`;
    rings.style.top = `${c.y - box.top}px`;
    let at = real;
    if (mode !== 'real') {
      at = { x: c.x + sim.dx, y: c.y + sim.dy };
      cursor.style.left = `${at.x - box.left}px`;
      cursor.style.top = `${at.y - box.top}px`;
      const key = `${at.x.toFixed(1)},${at.y.toFixed(1)}`;
      if (key !== sent) {
        sent = key;
        dispatchEvent(new MouseEvent('mousemove', { clientX: at.x, clientY: at.y }));
      }
    }

    if (labEyes) {
      const d = at ? Math.hypot(at.x - c.x, at.y - c.y) : null;
      const { now: e, target: g } = labEyes;
      const ojo = (i) => `${e[`w${i}`].toFixed(2)}×${e[`h${i}`].toFixed(2)} ${deg(e[`t${i}`])} p${e[`o${i}`].toFixed(2)}`;
      const rows = [
        ['cursor', mode === 'real' ? (real ? 'ratón' : 'fuera de la ventana') : 'simulado'],
        ['distancia', d === null ? '—' : `${d.toFixed(0)} px`],
        ['cara', lab.dataset.face || { info: 'curious', warn: 'suspicious', error: 'confused' }[lab.dataset.alert] || 'neutral'],
        ['yaw', `${deg(e.yaw)} → ${deg(g.yaw)}`],
        ['pitch', `${deg(e.pitch)} → ${deg(g.pitch)}`],
        ['roll', `${deg(e.roll)} → ${deg(g.roll)}`],
        ['ojo izq.', ojo(0)],
        ['ojo der.', ojo(1)],
      ];
      readout.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
      const lon = 0.5 + e.yaw / (2 * T.GAZE_MAX);
      const open = Math.min(1, Math.max(0, (e.h0 - 0.1) / 0.5));
      samples.push({ t: now, open, lon, d: d === null ? 1 : Math.min(d / T.GAZE_FULL, 1) });
      while (samples.length && now - samples[0].t > SPAN) samples.shift();
      plot(now);
    }

    const rate = Number($('rate').value);
    for (const a of document.getAnimations()) if (a.playbackRate !== rate) a.playbackRate = rate;
    M.speed = rate; // los ojos van por JS, con su propia velocidad
    syncWeb();

    requestAnimationFrame(frame);
  }

  // ---------- Tarjetas

  function card(parent, title, detail, bot, ground = 'dark') {
    const figure = document.createElement('figure');
    figure.innerHTML = `<div class="well ${ground}"></div><figcaption>${title}<small>${detail}</small></figcaption>`;
    figure.firstChild.append(bot);
    parent.append(figure);
    return figure;
  }

  const STATES = [
    ['Reposo · tono negro', 'Webs claras. Flota y sigue al cursor.', { 'data-tone': 'black' }, 'light'],
    ['Reposo · tono blanco', 'Webs oscuras (Crunchyroll siempre).', { 'data-tone': 'white' }],
    ['Aviso · ok', 'data-alert="ok"', { 'data-alert': 'ok' }],
    ['Aviso · info', 'data-alert="info"', { 'data-alert': 'info' }],
    ['Aviso · warn', 'data-alert="warn"', { 'data-alert': 'warn' }],
    ['Aviso · error', 'data-alert="error"', { 'data-alert': 'error' }],
    ['Panel abierto', 'aria-expanded="true": mira arriba a la derecha, al panel.', { 'aria-expanded': 'true', 'data-tone': 'white' }],
    ['Salto', 'Al abrir el panel o salir un aviso.', { 'data-tone': 'white' }, 'dark', true],
  ];
  const live = STATES.map(([title, detail, attrs, ground, jump]) => {
    const bot = make(attrs);
    const figure = card($('states'), title, detail, bot, ground);
    if (jump) {
      const button = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Saltar' });
      button.onclick = () => hop(bot);
      figure.querySelector('figcaption').append(button);
    }
    return bot;
  });

  // Bots fijos: montados como los demás, pero con la mirada clavada (pin) en vez de seguir al cursor
  const stills = [];
  function still(parent, title, detail, p) {
    const bot = make({ 'data-tone': 'white' });
    card(parent, title, detail, bot);
    stills.push([bot, p]);
  }
  const COMPASS = [
    ['↖ arriba izquierda', 225], ['↑ arriba', 270], ['↗ arriba derecha', 315],
    ['← izquierda', 180], [null], ['→ derecha', 0],
    ['↙ abajo izquierda', 135], ['↓ abajo', 90], ['↘ abajo derecha', 45],
  ];
  for (const [title, a] of COMPASS) {
    const r = (a * Math.PI) / 180;
    const p = title ? pose(T.GAZE_FULL * Math.cos(r), T.GAZE_FULL * Math.sin(r)) : neutral();
    still($('compass'), title || 'sin cursor', `yaw ${deg(p.yaw)} · pitch ${deg(p.pitch)}`, p);
  }
  for (const open of [0, 0.25, 0.5, 0.75, 1]) {
    const d = T.EYES_FAR - open * (T.EYES_FAR - T.EYES_NEAR);
    const p = pose(d * Math.cos(Math.PI / 6), d * Math.sin(Math.PI / 6));
    still($('opening'), `apertura ${open}`, `cursor a ${d.toFixed(0)} px`, p);
  }

  // Caras: la normal al frente (fija) y las de los avisos, que ya no siguen al cursor
  still($('faces'), 'normal', 'sin aviso u ok', neutral());
  const FACE_NAMES = { curious: ['curiosa', 'info'], suspicious: ['desconfiada', 'warn'], confused: ['confusa', 'error'] };
  const faces = expressions.map((name) => {
    const bot = make({ 'data-tone': 'white', 'data-face': name });
    const [title, kind] = FACE_NAMES[name] || [name, ''];
    card($('faces'), title, `data-face="${name}" · aviso ${kind}`, bot);
    return bot;
  });
  for (const well of $('faces').querySelectorAll('.well')) well.classList.add('big');

  // ---------- Avisos como en las webs: el bot y los avisos de src/content/common.js, con el chrome de mentira

  const web = $('web');
  let webHost = null;
  const NOTICES = [
    ['ok', { kind: 'ok', title: 'Episodio 5 marcado', text: 'Sousou no Frieren · 5/28' }],
    ['info', { kind: 'info', title: 'Ya estaba marcado', text: 'Sousou no Frieren · episodio 5' }],
    ['warn', { kind: 'warn', title: '¿Qué anime es?', text: 'No estoy seguro de que sea "Frieren". Pulsa aquí y elígelo.', fix: true }],
    ['error', { kind: 'error', title: 'No se pudo actualizar MyAnimeList', text: 'HTTP 401: token caducado' }],
    ['anime acabado', { kind: 'ok', title: '¡Anime completado!', text: 'Sousou no Frieren · ¿Qué nota le das?', rate: { id: 1, title: 'Sousou no Frieren', score: 0 } }],
  ];
  for (const [label, notice] of NOTICES) {
    const button = Object.assign(document.createElement('button'), { type: 'button', textContent: label });
    button.onclick = () => MALDev.send({ type: 'toast', notice });
    $('notice-buttons').append(button);
  }
  $('web-ground').onchange = () => {
    web.classList.toggle('light', $('web-ground').value === 'light');
    web.classList.toggle('dark', $('web-ground').value !== 'light');
  };
  // El bot de las webs (common.js lo cuelga fijo abajo a la izquierda de la ventana): se lleva al escenario
  MALDev.send({ type: 'mascot', show: true, text: '¡Episodio 5 de Sousou no Frieren! Lo marco cuando acabe.' });
  webHost = [...document.body.children].find((el) => el.shadowRoot?.querySelector('.card'));
  if (webHost) {
    Object.assign(webHost.style, { position: 'absolute', left: '8px', bottom: '10px', height: 'calc(100% - 20px)', zIndex: 'auto' });
    web.append(webHost);
  }
  // common.js le pone el tono según lo que hay en la esquina de la ventana; aquí manda el fondo del escenario
  function syncWeb() {
    const button = webHost?.shadowRoot.querySelector('button');
    const tone = $('web-ground').value === 'light' ? 'black' : 'white';
    if (button && button.getAttribute('aria-expanded') !== 'true' && button.dataset.tone !== tone) button.dataset.tone = tone;
  }

  Promise.all([lab, ...live, ...stills.map(([bot]) => bot), ...faces].map(mount))
    .then(([eyes, ...rest]) => {
      labEyes = eyes;
      rest.slice(live.length, live.length + stills.length).forEach((e, i) => e.pin(stills[i][1]));
      requestAnimationFrame(frame);
    })
    .catch((e) => {
      document.body.insertAdjacentHTML(
        'afterbegin',
        `<p class="note">No se pudo montar el bot (${e.message}). ¿Abierta desde file://? Usa la página de la extensión o un servidor.</p>`,
      );
    });
})();
