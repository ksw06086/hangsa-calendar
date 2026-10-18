const cacheName = "simon-one-v2";
const appShell = ["./", "./index.html", "./style.css", "./app.css", "./app.js", "./config.js"];
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll(appShell)));
});
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
