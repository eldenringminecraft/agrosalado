// Service worker de solo app-shell: instala la app para uso/carga offline.
// No cachea llamadas a Supabase — eso lo maneja IndexedDB (ver js/db-local.js
// y js/sync.js), para no tener dos mecanismos de "offline" compitiendo.

const CACHE_NAME = 'agrosalado-stock-shell-v68';

// Local: si falta CUALQUIERA de estos, no hay app-shell offline, así que
// tienen que cachearse sí o sí (si uno falla, falla toda la instalación).
const APP_SHELL_LOCAL = [
  './',
  './index.html',
  './manifest.json',
  './css/estilo.css',
  './js/app.js',
  './js/auth.js',
  './js/botones.js',
  './js/compradores.js',
  './js/config.js',
  './js/configPanel.js',
  './js/dashboard.js',
  './js/db-local.js',
  './js/export.js',
  './js/historial.js',
  './js/indices.js',
  './js/indicesConfig.js',
  './js/movimientos.js',
  './js/reportes.js',
  './js/rodeos.js',
  './js/router.js',
  './js/supabaseClient.js',
  './js/sync.js',
  './js/titulares.js',
  './js/trabajoManga.js',
  './js/trabajoMangaDetalle.js',
  '/assets/icon-512.png',
  '/assets/icon-192.png',
  '/assets/logo-full.png',
  '/assets/fondo-login.jpg',
];
// js/testing/mockSupabase.js NO va en esta lista a propósito: solo se carga
// en localhost con ?mocksupabase=1 (ver supabaseClient.js), así que no tiene
// sentido precachearlo en el celular de nadie.

// CDNs externos: mejor esfuerzo. Antes iban en el mismo cache.addAll() que
// lo local — un solo hipo de red cacheando esm.sh o sheetjs.com (algo común
// en wifi casera) hacía fallar TODA la instalación, dejando el celular sin
// ningún respaldo offline (ni siquiera el HTML/CSS/JS propio). Ahora, si
// estos fallan, la app igual carga offline (exportar a Excel puede no
// andar sin red, pero el resto sí).
const APP_SHELL_EXTERNO = [
  'https://esm.sh/@supabase/supabase-js@2',
  'https://cdn.sheetjs.com/xlsx-latest/package/dist/xlsx.full.min.js',
];

self.addEventListener('install', (evento) => {
  evento.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await cache.addAll(APP_SHELL_LOCAL);
      await Promise.all(
        APP_SHELL_EXTERNO.map((url) =>
          cache.add(url).catch((error) => console.warn('No se pudo precachear (no crítico):', url, error))
        )
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil(
    caches.keys().then((claves) =>
      Promise.all(claves.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (evento) => {
  const url = new URL(evento.request.url);

  // Nunca interceptar llamadas a la API/Auth de Supabase (datos en vivo).
  // El bundle de supabase-js (esm.sh) sí se cachea, como parte del app-shell,
  // para que el JS de la app pueda cargar aunque no haya conexión.
  if (url.hostname.endsWith('.supabase.co')) {
    return;
  }

  // version.json siempre de red: es justamente lo que usás para confirmar
  // que un deploy nuevo llegó, cachearlo rompería ese propósito.
  if (url.pathname === '/version.json') {
    return;
  }

  if (evento.request.method !== 'GET') return;

  evento.respondWith(
    caches.match(evento.request).then((cacheada) => {
      const red = fetch(evento.request)
        .then((respuesta) => {
          const copia = respuesta.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(evento.request, copia));
          return respuesta;
        })
        .catch(() => {
          if (cacheada) return cacheada;
          // Sin red y sin esta URL puntual en cache (ej. llegó con algo
          // distinto al final, o es la primera vez): si es una navegación,
          // devolvemos igual el shell de la app en vez de dejar que el
          // navegador muestre su propio error de "sin conexión".
          if (evento.request.mode === 'navigate') return caches.match('./index.html');
          return undefined;
        });
      return cacheada || red;
    })
  );
});
