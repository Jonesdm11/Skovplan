/* SkovPlan Felt – service worker: appen virker uden net, og kortfliser gemmes, når de er set. */
const APP = "skovplan-felt-v22";
const TILES = "skovplan-felt-tiles";
const SHELL = ["./", "index.html", "app.js", "style.css", "manifest.webmanifest", "favicon.png", "apple-touch-icon.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png",
  "logo.png", "logo-symbol.png",
  "lib/leaflet.js", "lib/leaflet.css", "lib/sql-wasm.js", "lib/sql-wasm.wasm", "lib/jszip.min.js",
  "lib/images/marker-icon.png", "lib/images/marker-shadow.png", "lib/images/layers.png"];
const MAX_TILES = 4000;

self.addEventListener("install", e => { e.waitUntil(caches.open(APP).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== APP && k !== TILES).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.hostname.endsWith("tile.openstreetmap.org")) {
    e.respondWith(caches.open(TILES).then(async c => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      try {
        const res = await fetch(e.request);
        if (res.ok || res.type === "opaque") { c.put(e.request, res.clone()); trim(c); }
        return res;
      } catch (err) { return new Response("", { status: 504 }); }
    }));
    return;
  }
  if (url.origin === location.origin) {
    // Netværk først (så nye versioner kommer med), cache når der ikke er net.
    e.respondWith(fetch(e.request, { cache: "no-cache" }).then(res => {   // forbi browserens 10-min-cache, så rettelser kommer med det samme
      if (res.ok) caches.open(APP).then(c => c.put(e.request, res.clone()));
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match("index.html"))));
  }
});
let trimming = false;
async function trim(c) {
  if (trimming) return; trimming = true;
  try { const keys = await c.keys(); for (let i = 0; i < keys.length - MAX_TILES; i++) await c.delete(keys[i]); } finally { trimming = false; }
}
