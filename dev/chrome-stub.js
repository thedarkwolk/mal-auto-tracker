// Un chrome de mentira para cargar src/content/common.js (el bot y los avisos de las webs, tal cual) en el banco de
// pruebas sin hablar con la extensión ni con MAL. Lo que mandaría el background se le pasa con MALDev.send(msg).
// Va antes que todo lo demás, también en la página de la extensión (allí tapa el chrome de verdad).
(() => {
  const listeners = [];
  const chrome = {
    runtime: {
      getURL: (path) => new URL(`../${path}`, location.href).href,
      // Puntuar un anime desde el aviso: como si se hubiera guardado
      sendMessage: async (msg) => (msg?.type === 'rate' ? { ok: true } : null),
      onMessage: { addListener: (fn) => listeners.push(fn) },
    },
    storage: { onChanged: { addListener() {} } },
  };
  Object.defineProperty(globalThis, 'chrome', { value: chrome, writable: true, configurable: true });
  globalThis.MALDev = { send: (msg) => listeners.forEach((fn) => fn(msg, {}, () => {})) };
})();
