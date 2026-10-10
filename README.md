# MAL Auto Tracker

Extensión de Chrome que marca automáticamente en tu lista de MyAnimeList el episodio que estás viendo en
Crunchyroll, JKAnime, AnimeFLV o Prime Video cuando llegas al 85 % del vídeo (configurable).

## Instalación

1. `chrome://extensions` → activa **Modo desarrollador** → **Cargar descomprimida** → elige esta carpeta.
2. Se abre la página de opciones. Copia la **Redirect URL** que aparece (`https://<id>.chromiumapp.org/`).
3. En <https://myanimelist.net/apiconfig> → **Create ID**: App Type `other`, App Redirect URL = la que copiaste.
4. Pega el **Client ID** en las opciones y guarda.
5. Pulsa el icono de la extensión (o la mascota de la esquina en las webs de anime) → **Conectar con MyAnimeList**.

> El ID de una extensión descomprimida depende de la ruta de la carpeta: si la mueves, cambia la Redirect URL
> y tendrás que actualizarla en MAL.

## Cómo funciona

- `src/content/sites/*.js` lee de cada web el título y el número de episodio (en el frame principal).
- `src/content/video-watcher.js` va en todos los frames (los reproductores suelen ser iframes de otros dominios)
  y avisa cuando el vídeo pasa del umbral.
- `src/background.js` busca el anime en MAL, guarda la asociación serie → anime y actualiza tu lista:
  - Solo sube el contador, nunca lo baja. Si ya está completado, no lo toca.
  - Pone *Viendo* y la fecha de inicio la primera vez, y *Completado* y la fecha de fin en el último episodio.
  - Si la web numera seguido entre temporadas (Crunchyroll: JJK E25), avanza por las secuelas de MAL.
  - Si la coincidencia es dudosa, no marca nada y te pide confirmarlo en el panel.
- Desde el panel (icono de la extensión o clic en la mascota) puedes corregir el anime (buscar o pegar un enlace de MAL) y restar episodios si hace falta.
  La corrección se recuerda para esa serie.

## Si una web cambia su diseño

Los selectores están en `src/content/sites/`. Recarga la extensión en `chrome://extensions` después de editarlos.
