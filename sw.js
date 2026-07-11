// Service Worker: アプリ本体をキャッシュしてオフラインでも起動できるようにする
const VERSION = 'kigen-v5';
const PHOTO_CACHE = 'kigen-photos-v1';
const SHELL = [
  './',
  'index.html',
  'css/style.css',
  'js/config.js',
  'js/db.js',
  'js/app.js',
  'vendor/supabase.min.js',
  'vendor/zxing.min.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== VERSION && k !== PHOTO_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // GAS版の画面(/gas/)はこのService Workerの管理外とする(常に最新を取得)
  if (url.origin === location.origin && url.pathname.includes('/gas/')) return;

  // アプリ本体: キャッシュ優先 + 裏で更新(次回起動時に反映)
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(e.request).then((cached) => {
        const fetched = fetch(e.request).then((res) => {
          if (res.ok) caches.open(VERSION).then((c) => c.put(e.request, res.clone())).catch(() => {});
          return res.clone();
        }).catch(() => cached);
        return cached || fetched;
      })
    );
    return;
  }

  // 商品写真: 一度表示したものはオフラインでも見られるようにする
  if (url.pathname.includes('/storage/v1/object/public/photos/')) {
    e.respondWith(
      caches.open(PHOTO_CACHE).then(async (c) => {
        const cached = await c.match(e.request);
        if (cached) return cached;
        const res = await fetch(e.request);
        if (res.ok) c.put(e.request, res.clone());
        return res;
      })
    );
  }
  // それ以外(APIなど)は素通し
});
