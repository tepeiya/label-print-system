// LabelFlow Service Worker —— 离线壳 + 网络优先（开发时始终拿最新文件）
const CACHE = 'labelflow-v3';
const SHELL = [
  './',
  './index.html',
  './css/app.css',
  './manifest.webmanifest',
  './icons/icon.svg',
  './js/app.js',
  './js/api.js',
  './js/guides.js',
  './js/inspector.js',
  './js/interactions.js',
  './js/jobs.js',
  './js/model.js',
  './js/print.js',
  './js/render.js',
  './js/store.js',
  './js/templates.js',
  './js/util.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html'))),
  );
});
