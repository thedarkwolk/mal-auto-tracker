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
    start(detect) {
      let last = null;
      const tick = () => {
        let info = null;
        try {
          info = detect();
        } catch (e) {
          console.debug('[MAL Auto]', e);
        }
        if (info && !(Number.isInteger(info.episode) && info.episode > 0 && info.title)) info = null;
        const sig = info ? JSON.stringify(info) : '';
        if (sig === last) return;
        last = sig;
        send(info ? { type: 'episode', info } : { type: 'noEpisode', site: currentSite() });
      };
      tick();
      setInterval(tick, 1500);
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

    toast: (text, kind) => showToast(text, kind),
  };

  // ---------- Avisos en pantalla

  let host;
  function showToast(text, kind = 'info') {
    if (!host) {
      host = document.createElement('div');
      host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
      const root = host.attachShadow({ mode: 'open' });
      const font = chrome.runtime.getURL('fonts/archivo-latin.woff2');
      root.innerHTML = `<style>
        @font-face{font-family:'MAL Archivo';src:url('${font}') format('woff2');font-weight:400 800}
        .t{display:flex;align-items:center;gap:12px;font:13px/1.4 'MAL Archivo','Segoe UI',system-ui,sans-serif;
           color:#ececef;background:#2c2d31;border:2px solid #141518;border-radius:4px;padding:12px 14px;margin-top:8px;
           box-shadow:0 10px 28px rgba(0,0,0,.5);max-width:360px;cursor:pointer;
           opacity:0;transform:translateY(8px);transition:opacity .25s,transform .25s}
        .t.show{opacity:1;transform:none}
        .i{width:30px;height:30px;flex:none;display:grid;place-items:center;border-radius:3px;
           font-weight:800;font-size:16px;color:#141413;background:#d97757}
        .warn .i{background:#ffd27a}.error .i{background:#ff8f8f}.info .i{background:#b8b9c0}
      </style><div id="box"></div>`;
    }
    // En pantalla completa solo se ve lo que cuelga del elemento a pantalla completa (si no es un iframe/vídeo).
    const fs = document.fullscreenElement;
    (fs && !['IFRAME', 'VIDEO'].includes(fs.tagName) ? fs : document.body).appendChild(host);
    const box = host.shadowRoot.getElementById('box');
    const el = document.createElement('div');
    el.className = `t ${kind}`;
    const icon = document.createElement('span');
    icon.className = 'i';
    icon.textContent = { ok: '✓', warn: '!', error: '✕' }[kind] || 'i';
    const body = document.createElement('span');
    body.textContent = text.replace(/^✓\s*/, '');
    el.append(icon, body);
    el.title = 'Clic para cerrar';
    const close = () => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 300);
    };
    el.onclick = close;
    box.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(close, kind === 'ok' ? 6000 : 10000);
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
        'position:fixed;left:8px;bottom:10px;width:min(380px,calc(100vw - 16px));height:min(680px,calc(100vh - 20px));' +
        'z-index:2147483646;pointer-events:none;';
      const root = mascotHost.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>
        .card{position:absolute;inset:0}
        .shade{position:absolute;inset:0;filter:drop-shadow(0 10px 24px rgba(0,0,0,.5))}
        .sheet{position:absolute;inset:0;overflow:hidden;background:#0a0a0c;border:2px solid #2a2a30;border-radius:6px;
               clip-path:circle(19px ${BALL});visibility:hidden;
               transition:clip-path .35s cubic-bezier(.4,0,.2,1),visibility 0s .35s}
        .open .sheet{clip-path:circle(150% ${BALL});visibility:visible;pointer-events:auto;
               transition:clip-path .5s cubic-bezier(.3,.7,.2,1) .12s,visibility 0s .12s}
        .panel{display:block;width:100%;height:calc(100% - 70px);border:0;border-bottom:1.5px solid #1c1c20;color-scheme:dark}
        button{all:unset;cursor:pointer;border-radius:50%}
        button:focus-visible{outline:2px solid #ececef;outline-offset:2px}
        ${globalThis.MALMascot.css}
        .card .mal-mascot{--m-size:56px;position:absolute;left:8px;bottom:6px;pointer-events:auto}
        .hop{animation:hop .45s cubic-bezier(.3,.7,.4,1)}
        @keyframes hop{25%{transform:translateY(4%) scale(1.1,.9)}55%{transform:translateY(-35%) scale(.95,1.05)}}
        @media (prefers-reduced-motion:reduce){.sheet,.open .sheet{transition:none}.hop{animation:none}}
      </style><div class="card"><div class="shade"><div class="sheet"></div></div>
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
    if (open) {
      button.classList.remove('hop');
      void button.offsetWidth; // reinicia el salto
      button.classList.add('hop');
    }
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
    if (msg.type === 'toast') showToast(msg.text, msg.kind);
    if (msg.type === 'mascot') showMascot(msg);
  });
})();
