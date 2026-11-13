/* TrEnDB offline script (service worker).
   - The site's own files: network first, so every visit gets the latest version; the saved copy
     is used only when there is no connection.
   - Pinned libraries and fonts from CDNs: saved once and reused (their addresses carry a version).
   - Everything else (the database, doi.org, PubChem, Crossref, sign-in) is never touched or stored here. */
"use strict";
var CACHE = "trendb-v1";
var CORE = [
  "./", "index.html", "admin.html", "manifest.webmanifest",
  "assets/style.css", "assets/config.js", "assets/score.js", "assets/chem-render.js", "assets/common.js",
  "assets/reactions.js", "assets/plotent.js", "assets/app.js", "assets/admin.js", "assets/pdf-extract.js",
  "assets/logo.svg", "assets/favicon.svg", "assets/app-icon.svg", "assets/apple-touch-icon.png",
  "assets/icon-192.png", "assets/icon-512.png", "assets/icon-maskable-192.png", "assets/icon-maskable-512.png"
];
var CDN = ["cdn.jsdelivr.net", "unpkg.com", "fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    /* one missing file must not stop the others from being saved */
    return Promise.all(CORE.map(function (u) { return c.add(new Request(u, { cache: "reload" })).catch(function () {}); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf("trendb-") === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

/* network first, but a connection that hangs for 4 s falls back to the saved copy */
function networkFirst(req) {
  var net = fetchAndSave(req);
  var slow = new Promise(function (resolve) {
    setTimeout(function () { caches.match(req, { ignoreSearch: true }).then(function (hit) { if (hit) resolve(hit); }); }, 4000);
  });
  return Promise.race([net, slow]);
}
function fetchAndSave(req) {
  return fetch(req).then(function (res) {
    if (res && res.ok && res.type === "basic") {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(req, copy); });
    }
    return res;
  }).catch(function () {
    return caches.match(req, { ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      if (req.mode === "navigate") return caches.match("index.html");
      return Response.error();
    });
  });
}
function cacheFirst(req) {
  return caches.match(req).then(function (hit) {
    if (hit) return hit;
    return fetch(req).then(function (res) {
      /* a library asked for with CORS (it has an integrity hash) may only be served from a CORS copy */
      var keep = res && (res.ok || (res.type === "opaque" && req.mode === "no-cors"));
      if (keep) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
      return res;
    });
  });
}

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin === self.location.origin) { e.respondWith(networkFirst(req)); return; }
  if (CDN.indexOf(url.hostname) >= 0) { e.respondWith(cacheFirst(req)); return; }
  /* anything else goes straight to the network, unseen */
});
