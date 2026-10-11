/*
 * Lets the line check open even when the tablet has no Wi-Fi.
 * Always tries the network first (so updates arrive straight away) and
 * falls back to the last copy it saw.
 */
const CACHE = "line-check-v1";
const SHELL = [
  "./", "index.html", "css/app.css", "css/print.css", "favicon.svg", "manifest.webmanifest",
  "js/app.mjs", "js/core.mjs", "js/dom.mjs", "js/line-template.mjs", "js/print.mjs", "js/store.mjs", "js/xlsx.mjs",
  "vendor/fflate.mjs", "img/hard-rock-logo.png", "img/hard-rock-logo-dark.png", "img/icon-192.png",
  "templates/line-check.xlsx", "templates/temperature-checklist.xlsx",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match("index.html"))),
  );
});
