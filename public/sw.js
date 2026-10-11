/*
 * Lets the line check open even when the tablet has no Wi-Fi.
 * Always tries the network first (so updates arrive straight away) and
 * falls back to the last copy it saw.
 */
const CACHE = "line-check-v2";
const SHELL = [
  "./", "index.html", "css/app.css", "css/print.css", "favicon.svg", "manifest.webmanifest",
  "js/boot.js", "js/app.mjs", "js/ctx.mjs", "js/core.mjs", "js/db.mjs", "js/dom.mjs", "js/keypad.mjs",
  "js/line-template.mjs", "js/photos.mjs", "js/print.mjs", "js/signature.mjs", "js/signoff.mjs", "js/store.mjs",
  "js/view-line.mjs", "js/view-print.mjs", "js/view-temps.mjs", "js/xlsx.mjs",
  "vendor/fflate.mjs", "img/hard-rock-logo.png", "img/hard-rock-logo-dark.png", "img/icon-192.png", "img/icon-512.png",
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

// Network first (so updates arrive straight away), but don't hang on a bad
// connection: after 4 seconds use the saved copy if there is one.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cached = caches.match(req, { ignoreSearch: true });
    const network = fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    });
    const slow = new Promise((resolve) => setTimeout(resolve, 4000));
    try {
      const first = await Promise.race([network, slow.then(() => cached)]);
      if (first) return first;
      return await network;
    } catch {
      return (await cached) || (await caches.match("index.html")) || Response.error();
    }
  })());
});
