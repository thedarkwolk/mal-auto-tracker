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

  // ---------- Avisos en pantalla: uno solo a la vez. Salen del bot igual que el panel (un círculo que crece desde la
  // bola) y lo dejan dentro, a la izquierda, con el texto a su derecha y la portada al final; el bot da un saltito y se
  // pone del color del aviso. Si ya hay uno, primero se recoge en el bot y después sale el nuevo. Con el panel abierto
  // no se despliegan encima: el bot solo
  // cambia de color un rato. Sin bot a la vista (desactivado o en pantalla completa), el mismo aviso abajo a la
  // izquierda, creciendo desde su esquina. Una línea fina abajo marca el tiempo que le queda y se para con el ratón.

  const NOTE_MS = { ok: 6000, info: 8000, warn: 10000, error: 10000 };
  const RATE_MS = 20000; // el de puntuar un anime acabado da más tiempo
  const NOTE_COLOR = { ok: '#3ecf8e', info: '#3b93f0', warn: '#f0b429', error: '#e8483f' };

  // Estilos del aviso, compartidos por el que va con el bot y el suelto. ${BALL} es la bola, como en el panel.
  const noteCss = () => `
    .nshade{position:absolute;left:0;bottom:0;width:min(380px,100%);filter:drop-shadow(0 10px 24px rgba(0,0,0,.5));pointer-events:none}
    .note{position:relative;box-sizing:border-box;min-height:70px;display:flex;align-items:center;gap:12px;
          padding:10px 12px 12px 76px;background:#0a0a0c;border:2px solid #2a2a30;border-radius:6px;overflow:hidden;
          font:12.5px/1.35 'MAL Archivo','Segoe UI',system-ui,sans-serif;color:#a1a1aa;cursor:pointer;
          clip-path:circle(19px ${BALL});visibility:hidden;
          transition:clip-path .35s cubic-bezier(.4,0,.2,1),visibility 0s .35s}
    .note.show{clip-path:circle(150% ${BALL});visibility:visible;pointer-events:auto;
          transition:clip-path .5s cubic-bezier(.3,.7,.2,1) .12s,visibility 0s .12s}
    .note.solo{padding-left:14px;clip-path:circle(0px at 0 100%)}
    .note.solo.show{clip-path:circle(150% at 0 100%);transition:clip-path .5s cubic-bezier(.3,.7,.2,1),visibility 0s}
    .note:hover{border-color:#3a3a41}
    .n-txt{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
    .n-txt strong{color:#f4f4f5;font-size:13.5px;font-weight:800}
    .n-pic{flex:none;width:34px;height:48px;object-fit:cover;border-radius:4px;background:#1f1f23}
    .n-pic[hidden]{display:none}
    .n-rate{display:flex;gap:3px;margin-top:6px}
    .n-rate button{all:unset;box-sizing:border-box;width:22px;height:22px;display:grid;place-items:center;border-radius:4px;
          background:#151518;border:1px solid #2a2a30;color:#f4f4f5;font-size:11px;font-weight:800;cursor:pointer}
    /* Como unas estrellas: al pasar por una nota se iluminan también las de antes; la que ya tenías sale marcada */
    .n-rate button.on,.n-rate button:hover,.n-rate button:has(~ button:hover){background:#f4f4f5;color:#0a0a0c;border-color:#f4f4f5}
    .n-rate:hover button.on:not(:hover):not(:has(~ button:hover)){background:#151518;color:#f4f4f5;border-color:#2a2a30}
    .n-rate button:disabled{opacity:.5;cursor:default}
    .life{position:absolute;left:0;right:0;bottom:0;height:2px;background:var(--nc);transform-origin:left;
          animation:life var(--ms) linear forwards}
    .note:hover .life{animation-play-state:paused}
    @keyframes life{to{transform:scaleX(0)}}
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

  // El bot vuelve a su color cuando el aviso ya se ha recogido en él (si no, se vería un momento sobre el aviso).
  function closeNote() {
    const run = ++noteRun;
    for (const root of [mascotHost?.shadowRoot, soloHost?.shadowRoot]) root?.querySelector('.note.show')?.classList.remove('show');
    setTimeout(() => {
      const button = botButton();
      if (run === noteRun && button) delete button.dataset.alert;
    }, 350);
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
      button.dataset.alert = kind;
      setTimeout(() => run === noteRun && delete button.dataset.alert, ms);
      return;
    }

    const note = noteRoot().querySelector('.note');
    const canFix = fix && !note.classList.contains('solo');
    const fill = () => {
      note.style.setProperty('--nc', NOTE_COLOR[kind] || NOTE_COLOR.info);
      note.style.setProperty('--ms', `${ms}ms`);
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

    // Sale desde el bot: el bot se pone de su color, da el saltito y el aviso crece desde la bola.
    const open = () => {
      if (run !== noteRun) return;
      if (button) button.dataset.alert = kind;
      fill();
      requestAnimationFrame(() => run === noteRun && note.classList.add('show'));
      if (button && !document.fullscreenElement) hop();
    };
    if (note.classList.contains('show')) {
      // Ya había uno: primero se recoge en el bot (lo que tarda su transición) y después sale el nuevo.
      note.classList.remove('show');
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
  // al pulsarlo da un salto y el panel crece desde él como un círculo hasta llenar la tarjeta, con el bot
  // dentro en su esquina. La tarjeta ocupa siempre su sitio pero sin recoger clics: solo el bot y el panel abierto.
  // El panel llena la tarjeta; su franja de abajo (la barra de filtros) deja hueco a la izquierda para el bot,
  // que va encima.
  // Centro de la bola en la tarjeta: x = 8 + 56/2; y (desde abajo) = 6 + alto del bot × (1 − 72/130).
  const BALL = 'at 36px calc(100% - 33px)';

  let mascotHost;
  setInterval(() => {
    if (mascotHost?.isConnected && !panelOpen()) mascotHost.shadowRoot.querySelector('button').dataset.tone = pageTone();
  }, 2000);

  function showMascot({ show, mood, text }) {
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
        .shade{position:absolute;inset:0;filter:drop-shadow(0 10px 24px rgba(0,0,0,.5))}
        .sheet{position:absolute;inset:0;overflow:hidden;background:#0a0a0c;border:2px solid #2a2a30;border-radius:6px;
               clip-path:circle(19px ${BALL});visibility:hidden;
               transition:clip-path .35s cubic-bezier(.4,0,.2,1),visibility 0s .35s}
        .open .sheet{clip-path:circle(150% ${BALL});visibility:visible;pointer-events:auto;
               transition:clip-path .5s cubic-bezier(.3,.7,.2,1) .12s,visibility 0s .12s}
        .panel{display:block;width:100%;height:100%;border:0;color-scheme:dark}
        button{all:unset;cursor:pointer;border-radius:50%}
        button:focus-visible{outline:2px solid #ececef;outline-offset:2px}
        ${globalThis.MALMascot.css}
        .card .mal-mascot{--m-size:56px;position:absolute;left:8px;bottom:6px;pointer-events:auto}
        .hop{animation:hop .45s cubic-bezier(.3,.7,.4,1)}
        @keyframes hop{25%{transform:translateY(4%) scale(1.1,.9)}55%{transform:translateY(-35%) scale(.95,1.05)}}
        @media (prefers-reduced-motion:reduce){.sheet,.open .sheet{transition:none}.hop{animation:none}}
        ${noteCss()}
      </style><div class="card"><div class="shade"><div class="sheet"></div></div>${noteHtml()}
        <button class="mal-mascot" aria-expanded="false">${globalThis.MALMascot.svg}</button></div>`;
      root.querySelector('button').onclick = () => setPanel(!panelOpen());
      globalThis.MALMascot.mount(root.querySelector('button')).catch((e) => console.debug('[MAL Auto]', e));
    }
    // En pantalla completa no se ve: solo cuelga del body, como debe ser mientras ves el episodio.
    if (!mascotHost.isConnected) document.body.appendChild(mascotHost);
    const button = mascotHost.shadowRoot.querySelector('button');
    button.dataset.mood = mood;
    button.dataset.tone = panelOpen() ? 'white' : pageTone();
    button.title = `${text}\n(Clic para abrir o cerrar el panel)`;
    button.setAttribute('aria-label', `${text} Abrir el panel de MAL Auto Tracker`);
  }

  // ---------- Panel: la misma página que el popup del icono, en un iframe dentro de la tarjeta del bot.
  // Se carga la primera vez que se abre y después solo se recoge, para que reabrirlo sea instantáneo.

  let panel;
  const panelOpen = () => !!mascotHost?.shadowRoot.querySelector('.card.open');

  function hop() {
    const button = mascotHost.shadowRoot.querySelector('button');
    button.classList.remove('hop');
    void button.offsetWidth; // reinicia el salto
    button.classList.add('hop');
  }
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
    // Dentro del panel (oscuro) va en blanco; al cerrarlo vuelve al tono de la web cuando el panel ya se ha recogido.
    if (open) button.dataset.tone = 'white';
    else setTimeout(() => !panelOpen() && (button.dataset.tone = pageTone()), 350);
    if (open) hop();
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

  // Cambió la configuración o la cuenta de MAL: se vuelve a preguntar qué cara poner.
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
