// Utilidades compartidas por los detectores de cada web (solo en el frame principal).
(() => {
  if (window.MALAuto) return;

  const send = (msg) => {
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch {
      // La extensión se recargó: este content script ya no puede hablar con ella.
    }
  };

  window.MALAuto = {
    // Llama a detect() periódicamente (las webs son SPA) y avisa al background cuando cambia.
    // nav(): { prev, next } con las URLs del episodio anterior y el siguiente, si la web las da en la página; si no,
    // y sus URLs llevan el número (link.template), se construyen. El panel las pide para moverse entre episodios.
    start(detect, { nav } = {}) {
      let last = null;
      let current = null;
      const tick = () => {
        let info = null;
        try {
          info = detect();
        } catch (e) {
          console.debug('[MAL Auto]', e);
        }
        if (info && !(Number.isInteger(info.episode) && info.episode > 0 && info.title)) info = null;
        current = info;
        const sig = info ? JSON.stringify(info) : '';
        if (sig === last) return;
        last = sig;
        send(info ? { type: 'episode', info } : { type: 'noEpisode', site: currentSite() });
      };
      tick();
      setInterval(tick, 1500);

      chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (msg.type !== 'episodeNav') return;
        if (!current) return sendResponse(null);
        if (nav) return sendResponse(nav());
        const template = current.link?.template;
        const at = (ep) => template.replace('{ep}', ep);
        sendResponse(template ? { prev: current.episode > 1 ? at(current.episode - 1) : null, next: at(current.episode + 1) } : null);
      });
    },

    slugToTitle(slug) {
      return decodeURIComponent(slug)
        .replace(/[-_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\b\w/g, (c) => c.toUpperCase());
    },

    text(selector) {
      return document.querySelector(selector)?.textContent.replace(/\s+/g, ' ').trim() || '';
    },

    // notice: { kind, title, text, picture, fix } (ver showToast)
    toast: (notice) => showToast(notice),
  };

  // ---------- Avisos en pantalla: uno solo a la vez. Salen de detrás del bot: una pestaña de su alto que se despliega
  // hacia la derecha desde la bola, con el texto, mientras el bot da la vuelta y se pone del color y la cara del aviso. Ese color
  // se va apagando en lo que dura el aviso: es su cuenta atrás. Si ya hay uno, primero se recoge en el bot y después
  // sale el nuevo. Con el panel abierto no se despliegan encima: el bot solo cambia de color y de cara un rato. Sin bot
  // a la vista (desactivado o en pantalla completa), el aviso va suelto abajo a la izquierda, creciendo desde su esquina
  // y con una línea fina abajo como cuenta atrás. Las dos cuentas atrás se paran con el ratón encima del aviso.

  const NOTE_MS = { ok: 6000, info: 8000, warn: 10000, error: 10000 };
  const RATE_MS = 20000; // el de puntuar un anime acabado da más tiempo
  const NOTE_COLOR = { ok: '#3ecf8e', info: '#3b93f0', warn: '#f0b429', error: '#e8483f' };

  // Estilos del aviso, compartidos por el que va con el bot y el suelto. El del bot es una pestaña del alto de la bola
  // (37px) que sale de detrás de ella: empieza en su centro (BALL: a 36px de la izquierda y 33px del fondo de la
  // tarjeta), así que la bola tapa su lado izquierdo, y solo el derecho es redondo. El texto va a la derecha de la bola
  // en dos líneas. Se despliega en lo que dura la vuelta del bot y con su curva: el recorte empieza siendo la bola (un
  // círculo con su centro y su radio) y se alarga hacia la derecha, así que su lado izquierdo siempre queda detrás de
  // ella y no asoman las esquinas. Su borde
  // es del color de la bola: sube al del aviso con la vuelta y se apaga con ella (--tone, su color normal; --fade, lo
  // que dura la cuenta atrás; --from, el color que tiene la bola al salir, que si aún se apagaba del aviso anterior
  // no es el normal).
  const spinMs = () => globalThis.MALMascot?.tuning.SPIN_MS ?? 800;
  const SPIN = () => `${spinMs()}ms cubic-bezier(.65,0,.35,1)`;
  const noteCss = () => `
    .nshade{position:absolute;left:0;bottom:0;width:min(380px,100%);filter:drop-shadow(0 10px 24px rgba(0,0,0,.5));pointer-events:none}
    .note{position:relative;box-sizing:border-box;display:flex;align-items:center;gap:10px;
          background:#0a0a0c;border:2px solid #2a2a30;overflow:hidden;
          font:12.5px/1.35 'MAL Archivo','Segoe UI',system-ui,sans-serif;color:#a1a1aa;cursor:pointer;visibility:hidden;
          transition:clip-path .35s cubic-bezier(.4,0,.2,1),visibility 0s .35s}
    .note.show{visibility:visible;pointer-events:auto}
    .note:not(.solo){height:37px;margin:0 0 14.5px 36px;padding:0 16px 0 29px;border-left:0;border-radius:0 18.5px 18.5px 0;
          line-height:1.25;clip-path:inset(0 calc(100% - 18.5px) 0 -18.5px round 18.5px);
          transition:clip-path ${SPIN()},visibility 0s ${spinMs()}ms;animation:n-ink-back ${SPIN()} forwards}
    .note:not(.solo).quick{transition:clip-path .35s cubic-bezier(.4,0,.2,1),visibility 0s .35s}
    .note:not(.solo).show{clip-path:inset(0 0 0 -18.5px round 18.5px);transition:clip-path ${SPIN()},visibility 0s;
          animation:n-ink-in ${SPIN()},n-ink-out var(--fade) linear ${spinMs()}ms forwards}
    .note:not(.solo){border-color:var(--tone)}
    .note:not(.solo).show:hover{animation-play-state:paused}
    @keyframes n-ink-in{from{border-color:var(--from)}to{border-color:var(--nc)}}
    @keyframes n-ink-out{from{border-color:var(--nc)}to{border-color:var(--tone)}}
    @keyframes n-ink-back{from{border-color:var(--from)}to{border-color:var(--tone)}}
    .note:not(.solo) .n-txt{gap:0}
    .note:not(.solo) .n-txt > :not(.n-rate){white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .note:not(.solo) .n-pic{width:22px;height:30px;border-radius:3px}
    /* Para poner nota no caben tres líneas: el título y los botones */
    .note:not(.solo) .n-txt:has(.n-rate) > span:not(.n-rate){display:none}
    .note.solo{min-height:70px;padding:10px 12px 12px 14px;border-radius:6px;clip-path:circle(0px at 0 100%)}
    .note.solo.show{clip-path:circle(150% at 0 100%);transition:clip-path .5s cubic-bezier(.3,.7,.2,1),visibility 0s}
    .note.solo:hover{border-color:#3a3a41}
    .n-txt{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
    .n-txt strong{color:#f4f4f5;font-size:13.5px;font-weight:800}
    .n-pic{flex:none;width:34px;height:48px;object-fit:cover;border-radius:4px;background:#1f1f23}
    .n-pic[hidden]{display:none}
    .n-rate{display:flex;gap:3px;margin-top:6px}
    .n-rate button{all:unset;box-sizing:border-box;width:22px;height:22px;display:grid;place-items:center;border-radius:4px;
          background:#151518;border:1px solid #2a2a30;color:#f4f4f5;font-size:11px;font-weight:800;cursor:pointer}
    /* Como unas estrellas: al pasar por una nota se iluminan también las de antes; la que ya tenías sale marcada */
    .note:not(.solo) .n-rate{gap:2px}
    .note:not(.solo) .n-rate button{width:19px;height:16px;font-size:9.5px;border-radius:3px}
    .n-rate button.on,.n-rate button:hover,.n-rate button:has(~ button:hover){background:#f4f4f5;color:#0a0a0c;border-color:#f4f4f5}
    .n-rate:hover button.on:not(:hover):not(:has(~ button:hover)){background:#151518;color:#f4f4f5;border-color:#2a2a30}
    .n-rate button:disabled{opacity:.5;cursor:default}
    .note:not(.solo) .life{visibility:hidden}
    .life{position:absolute;left:0;right:0;bottom:0;height:2px;background:var(--nc);transform-origin:left;
          animation:life var(--ms) linear forwards}
    .note:hover .life{animation-play-state:paused}
    @keyframes life{to{transform:scaleX(0)}}
    @keyframes n-float{0%,100%{transform:translateY(0)}50%{transform:translateY(var(--fy))}}
    @media (prefers-reduced-motion:reduce){.note,.note.show,.note.solo.show{transition:none}}`;
  const noteHtml = (solo = false) =>
    `<div class="nshade"><div class="note${solo ? ' solo' : ''}" role="status">` +
    `<span class="n-txt"></span><img class="n-pic" alt="" hidden></div></div>`;
  const fontFace = () =>
    `@font-face{font-family:'MAL Archivo';src:url('${chrome.runtime.getURL('fonts/archivo-latin.woff2')}') format('woff2');font-weight:400 800}`;

  let noteRun = 0; // el aviso en curso: uno nuevo, o cerrarlo, invalida lo pendiente del anterior
  let soloHost;

  // Dónde va el aviso: en la tarjeta del bot si se ve; si no, en uno suelto abajo a la izquierda.
  function noteRoot() {
    if (mascotHost?.isConnected && !document.fullscreenElement) return mascotHost.shadowRoot;
    if (!soloHost) {
      soloHost = document.createElement('div');
      soloHost.style.cssText =
        'position:fixed;left:16px;bottom:16px;width:min(380px,calc(100vw - 32px));height:120px;z-index:2147483647;pointer-events:none;';
      soloHost.attachShadow({ mode: 'open' }).innerHTML = `<style>${fontFace()}${noteCss()}</style>${noteHtml(true)}`;
    }
    // En pantalla completa solo se ve lo que cuelga del elemento a pantalla completa (si no es un iframe/vídeo).
    const fs = document.fullscreenElement;
    (fs && !['IFRAME', 'VIDEO'].includes(fs.tagName) ? fs : document.body).appendChild(soloHost);
    return soloHost.shadowRoot;
  }

  const botButton = () => (mascotHost?.isConnected ? mascotHost.shadowRoot.querySelector('button') : null);

  // El bot con el color y la cara del aviso (src/mascot.js): da la vuelta y luego se va apagando en lo que queda.
  let notices = 0;
  // El color que tiene ahora la bola (y sus ojos), del que sale la animación siguiente: si se estaba apagando, no es el
  // normal ni el del aviso.
  function holdColor(button) {
    for (const part of ['ink', 'paper']) {
      button.style.setProperty(`--m-from-${part}`, getComputedStyle(button.querySelector(`.m-${part}`)).fill);
    }
  }
  function alertBot(button, kind, ms) {
    holdColor(button);
    delete button.dataset.unfade;
    button.dataset.alert = kind;
    button.dataset.notice = ++notices; // aunque sea del mismo tipo, es otro: vuelve a dar la vuelta
    delete button.dataset.fade;
    void button.offsetWidth; // si ya había un aviso, la cuenta atrás vuelve a empezar
    button.style.setProperty('--m-fade', `${Math.max(ms - spinMs(), 0)}ms`);
    button.dataset.fade = '';
  }
  // La pestaña del aviso flota con la bola (m-float en src/mascot.js), al mismo compás: si se quedara quieta, al subir
  // la bola le asomaría el borde por debajo. Mismas keyframes, misma duración y la misma fase que lleva la bola ahora.
  function floatWith(button, shade) {
    const body = button?.querySelector('.m-body');
    const float = body?.getAnimations().find((a) => a.animationName === 'm-float');
    if (!float) return (shade.style.animation = ''); // sin bot, o sin flote (movimiento reducido)
    shade.style.setProperty('--fy', `${-0.04 * body.offsetHeight}px`);
    const { duration } = float.effect.getTiming();
    shade.style.animation = 'none';
    void shade.offsetWidth; // si ya flotaba, empieza de cero en la fase de la bola
    shade.style.animation = `n-float ${duration}ms ease-in-out ${-float.currentTime}ms infinite`;
  }
  let unfades = 0;
  // Acaba el aviso en el bot: da la vuelta de regreso a su cara normal y vuelve a su color durante ella.
  function unalertBot(button) {
    if (!button.dataset.alert) return;
    holdColor(button);
    delete button.dataset.alert;
    delete button.dataset.fade;
    delete button.dataset.notice;
    delete button.dataset.unfade;
    void button.offsetWidth; // reinicia la vuelta al color si ya estaba puesta
    button.dataset.unfade = '';
    // Acabada, fuera: si no, al cambiar luego de tono (abrir el panel) saltaría al nuevo sin transición
    const mark = ++unfades;
    setTimeout(() => mark === unfades && !button.dataset.alert && delete button.dataset.unfade, spinMs() + 50);
  }

  // Recoge el aviso hacia la bola: con su borde volviendo al color normal desde el que tiene y, si va a salir otro
  // enseguida (quick), deprisa y sin acompañar a la vuelta del bot.
  function retract(note, quick = false) {
    note.style.setProperty('--from', getComputedStyle(note).borderTopColor);
    note.classList.toggle('quick', quick);
    note.classList.remove('show');
  }

  // El aviso se recoge en el bot mientras este da la vuelta de regreso.
  function closeNote() {
    ++noteRun;
    for (const root of [mascotHost?.shadowRoot, soloHost?.shadowRoot]) {
      const note = root?.querySelector('.note.show');
      if (note) retract(note);
    }
    const button = botButton();
    if (button) unalertBot(button);
  }

  // Fila de notas del 1 al 10 de un anime acabado. Al elegir una se guarda en MAL y el aviso pasa a confirmarla.
  function rateRow({ id, title, score = 0 }, picture) {
    const row = Object.assign(document.createElement('span'), { className: 'n-rate' });
    for (let n = 1; n <= 10; n++) {
      const b = Object.assign(document.createElement('button'), { textContent: n, title: `Ponerle un ${n}` });
      if (n <= score) b.classList.add('on');
      b.onclick = async (e) => {
        e.stopPropagation(); // no cierra el aviso
        row.querySelectorAll('button').forEach((x) => (x.disabled = true));
        let res;
        try {
          res = await chrome.runtime.sendMessage({ type: 'rate', id, score: n });
        } catch (err) {
          res = { ok: false, error: err.message };
        }
        showToast(
          res?.ok
            ? { kind: 'ok', title: `Nota guardada · ★ ${n}`, text: title, picture }
            : { kind: 'error', title: 'No se pudo guardar la nota', text: res?.error || '' },
        );
      };
      row.append(b);
    }
    return row;
  }

  // notice: { kind: ok | info | warn | error, title, text, picture (portada), fix (pulsarlo abre el panel),
  //           rate: { id, title, score } (pide una nota del 1 al 10) }
  function showToast({ kind = 'info', title = '', text = '', picture = null, fix = false, rate = null } = {}) {
    const run = ++noteRun;
    const ms = rate ? RATE_MS : NOTE_MS[kind] || NOTE_MS.info;
    const button = botButton();
    if (panelOpen()) {
      alertBot(button, kind, ms);
      setTimeout(() => run === noteRun && unalertBot(button), ms);
      return;
    }

    const note = noteRoot().querySelector('.note');
    const canFix = fix && !note.classList.contains('solo');
    const fill = () => {
      note.style.setProperty('--nc', NOTE_COLOR[kind] || NOTE_COLOR.info);
      note.style.setProperty('--ms', `${ms}ms`);
      note.style.setProperty('--fade', `${Math.max(ms - spinMs(), 0)}ms`);
      if (button) note.style.setProperty('--tone', getComputedStyle(button).getPropertyValue('--m-tone-ink'));
      const txt = note.querySelector('.n-txt');
      txt.replaceChildren();
      if (title) txt.append(Object.assign(document.createElement('strong'), { textContent: title }));
      if (text) txt.append(Object.assign(document.createElement('span'), { textContent: text }));
      if (rate) txt.append(rateRow(rate, picture));
      const pic = note.querySelector('.n-pic');
      pic.hidden = !picture || !!rate; // con la fila de notas no cabe la portada
      pic.onerror = () => (pic.hidden = true); // la web no deja cargar la portada (su política de seguridad)
      if (picture) pic.src = picture;
      // La línea de tiempo, nueva para cada aviso. Se cierra al llegar al final con la promesa de la animación y no
      // con su evento, que no llega mientras la pestaña está en segundo plano.
      note.querySelector('.life')?.remove();
      const life = Object.assign(document.createElement('span'), { className: 'life' });
      note.append(life);
      const anim = life.getAnimations()[0];
      (anim ? anim.finished : new Promise((r) => setTimeout(r, ms))).then(() => run === noteRun && closeNote(), () => {});
    };
    note.title = canFix ? 'Pulsa para abrir el panel' : 'Pulsa para cerrar';
    note.onclick = () => (canFix ? setPanel(true) : closeNote());

    // Sale desde el bot: el bot da la vuelta y se pone de su color y su cara (src/mascot.js), y el aviso crece desde la bola.
    const open = () => {
      if (run !== noteRun) return;
      note.classList.remove('quick');
      if (button) alertBot(button, kind, ms);
      // El borde sale del mismo color que la bola
      note.style.setProperty('--from', button?.style.getPropertyValue('--m-from-ink') || 'transparent');
      fill();
      floatWith(button, note.parentElement);
      requestAnimationFrame(() => run === noteRun && note.classList.add('show'));
    };
    if (note.classList.contains('show')) {
      // Ya había uno: primero se recoge en el bot, deprisa y sin vuelta, y después sale el nuevo con la suya.
      retract(note, true);
      setTimeout(open, 380);
    } else open();
  }

  // ---------- El bot (la mascota), abajo a la izquierda. El background decide qué cara pone y qué dice (en el
  // tooltip); al pulsarlo se despliega el panel de la extensión.

  // En qué web compatible está la pestaña, para que la mascota sepa que estás buscando qué ver.
  // En Amazon solo cuenta la parte de vídeo, no la tienda.
  function currentSite() {
    const { hostname, pathname } = location;
    if (hostname.endsWith('crunchyroll.com')) return 'crunchyroll';
    if (hostname.endsWith('jkanime.net')) return 'jkanime';
    if (hostname.endsWith('animeflv.net')) return 'animeflv';
    if (hostname.endsWith('primevideo.com') || /\/(gp\/video|video)\//.test(pathname)) return 'primevideo';
    return null;
  }

  // Bola negra en webs claras y blanca en las oscuras, según el primer fondo pintado detrás de la esquina.
  // Crunchyroll es oscura entera: siempre blanca.
  function pageTone() {
    if (currentSite() === 'crunchyroll') return 'white';
    for (const el of document.elementsFromPoint(44, innerHeight - 44)) {
      if (el === mascotHost) continue;
      const rgba = getComputedStyle(el).backgroundColor.match(/[\d.]+/g)?.map(Number);
      if (!rgba || (rgba[3] ?? 1) <= 0.5) continue;
      const [r, g, b] = rgba;
      return 0.2126 * r + 0.7152 * g + 0.0722 * b > 140 ? 'black' : 'white';
    }
    return 'black'; // nada pintado: se ve el lienzo blanco del navegador
  }

  // El bot (la mascota) y el panel van en una misma tarjeta fija abajo a la izquierda. Cerrada solo se ve el bot;
  // al pulsarlo da la vuelta y el panel sale de la bola como los avisos: el recorte empieza siendo ella y crece hasta
  // llenar la tarjeta en lo que dura la vuelta, con el bot dentro en su esquina. Al cerrarlo, al revés. La tarjeta ocupa siempre su sitio pero sin recoger clics: solo el bot y el panel abierto.
  // El panel llena la tarjeta; su franja de abajo (la barra de filtros) deja hueco a la izquierda para el bot,
  // que va encima.
  // La bola en la tarjeta como recorte inset (arriba, derecha, abajo, izquierda): centro en x = 8 + 56/2 = 36px e
  // y (desde abajo) = 6 + alto del bot × (1 − 72/130) ≈ 33px, radio 18,5px.
  const BALL = 'calc(100% - 51.5px) calc(100% - 54.5px) 14.5px 17.5px';

  let mascotHost;
  setInterval(() => {
    if (mascotHost?.isConnected && !panelOpen()) mascotHost.shadowRoot.querySelector('button').dataset.tone = pageTone();
  }, 2000);

  function showMascot({ show, text }) {
    if (!show || !globalThis.MALMascot) {
      if (mascotHost) setPanel(false);
      mascotHost?.remove();
      return;
    }
    if (!mascotHost) {
      mascotHost = document.createElement('div');
      mascotHost.style.cssText =
        'position:fixed;left:8px;bottom:10px;width:min(440px,calc(100vw - 16px));height:min(680px,calc(100vh - 20px));' +
        'z-index:2147483646;pointer-events:none;';
      const root = mascotHost.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>
        ${fontFace()}
        .card{position:absolute;inset:0}
        .card:has(.note.show:hover) .mal-mascot :is(.m-ink,.m-paper){animation-play-state:paused}
        .shade{position:absolute;inset:0;filter:drop-shadow(0 10px 24px rgba(0,0,0,.5))}
        .sheet{position:absolute;inset:0;overflow:hidden;background:#0a0a0c;border:2px solid #2a2a30;border-radius:6px;
               clip-path:inset(${BALL} round 18.5px);visibility:hidden;
               transition:clip-path ${SPIN()},visibility 0s ${spinMs()}ms}
        .open .sheet{clip-path:inset(0 round 6px);visibility:visible;pointer-events:auto;
               transition:clip-path ${SPIN()},visibility 0s}
        .panel{display:block;width:100%;height:100%;border:0;color-scheme:dark}
        button{all:unset;cursor:pointer;border-radius:50%}
        button:focus-visible{outline:2px solid #ececef;outline-offset:2px}
        ${globalThis.MALMascot.css}
        .card .mal-mascot{--m-size:56px;position:absolute;left:8px;bottom:6px;pointer-events:auto}
        @media (prefers-reduced-motion:reduce){.sheet,.open .sheet{transition:none}}
        ${noteCss()}
      </style><div class="card"><div class="shade"><div class="sheet"></div></div>${noteHtml()}
        <button class="mal-mascot" aria-expanded="false">${globalThis.MALMascot.svg}</button></div>`;
      root.querySelector('button').onclick = () => setPanel(!panelOpen());
      globalThis.MALMascot.mount(root.querySelector('button')).catch((e) => console.debug('[MAL Auto]', e));
    }
    // En pantalla completa no se ve: solo cuelga del body, como debe ser mientras ves el episodio.
    if (!mascotHost.isConnected) document.body.appendChild(mascotHost);
    const button = mascotHost.shadowRoot.querySelector('button');
    button.dataset.tone = panelOpen() ? 'white' : pageTone();
    button.title = `${text}\n(Clic para abrir o cerrar el panel)`;
    button.setAttribute('aria-label', `${text} Abrir el panel de MAL Auto Tracker`);
  }

  // ---------- Panel: la misma página que el popup del icono, en un iframe dentro de la tarjeta del bot.
  // Se carga la primera vez que se abre y después solo se recoge, para que reabrirlo sea instantáneo.

  let panel;
  const panelOpen = () => !!mascotHost?.shadowRoot.querySelector('.card.open');

  function setPanel(open) {
    const root = mascotHost.shadowRoot;
    const card = root.querySelector('.card');
    if (open && !panel) {
      panel = document.createElement('iframe');
      panel.className = 'panel';
      panel.title = 'MAL Auto Tracker';
      panel.src = chrome.runtime.getURL('popup/popup.html');
      root.querySelector('.sheet').append(panel);
    }
    if (open === card.classList.contains('open')) return;
    card.classList.toggle('open', open);
    const button = root.querySelector('button');
    button.setAttribute('aria-expanded', String(open));
    // Dentro del panel (oscuro) va en blanco; al cerrarlo, al tono de la web. El color cambia durante la vuelta
    // (src/mascot.js gira al cambiar aria-expanded).
    button.dataset.tone = open ? 'white' : pageTone();
    if (open) closeNote(); // el panel ocupa el sitio del aviso
  }

  // Se cierra con un clic fuera (los de dentro del iframe no llegan aquí), con Esc o desde el propio panel.
  document.addEventListener(
    'click',
    (e) => {
      if (panelOpen() && !e.composedPath().includes(mascotHost)) setPanel(false);
    },
    true,
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panelOpen()) setPanel(false);
  });
  window.addEventListener('message', (e) => {
    if (panel && e.source === panel.contentWindow && e.data?.malAuto === 'closePanel') setPanel(false);
  });

  // Cambió la configuración o la cuenta de MAL: se vuelve a preguntar qué decir (o si se ve).
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (!((area === 'sync' && 'settings' in changes) || (area === 'local' && 'auth' in changes))) return;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'getMascot', site: currentSite() });
      if (res?.ok) showMascot(res);
    } catch {
      // La extensión se recargó: este content script ya no puede hablar con ella.
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'toast') showToast(msg.notice);
    if (msg.type === 'mascot') showMascot(msg);
  });
})();
