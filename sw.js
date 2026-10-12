// Keeps the app opening when the connection drops, and shows phone notifications. The network is always
// tried first, so a new version shows up as soon as the phone is online; the saved copy is only the
// fallback. Data is never saved here.
const CACHE = "edit-room-shell-4";
const SHELL = ["./", "styles.css", "fonts.css", "app.js", "config.js", "manifest.webmanifest", "icon-192.png", "badge-96.png",
  "fonts/barlow-latin-400-normal.woff2", "fonts/barlow-latin-500-normal.woff2", "fonts/barlow-latin-600-normal.woff2"];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  if (new URL(req.url).origin !== self.location.origin) return;      // the data server is never touched
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && res.type === "basic") {
        const copy = res.clone();
        event.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}));
      }
      return res;
    } catch (err) {
      const hit = (await caches.match(req, { ignoreSearch: true })) || (req.mode === "navigate" ? await caches.match("./") : null);
      if (hit) return hit;
      throw err;
    }
  })());
});

// A notification from the DN Studios sender: show it (with a buzz where the phone allows), and tell any
// open copy of the app to fetch what changed.
self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { body: event.data ? event.data.text() : "" }; }
  const title = typeof d.title === "string" && d.title ? d.title.slice(0, 120) : "DN Studios";
  event.waitUntil((async () => {
    await self.registration.showNotification(title, {
      body: typeof d.body === "string" ? d.body.slice(0, 300) : "",
      icon: "icon-192.png",
      badge: "badge-96.png",
      tag: typeof d.tag === "string" ? d.tag.slice(0, 100) : undefined,
      renotify: typeof d.tag === "string",
      vibrate: [180, 80, 180],
      data: { url: "./" },
    });
    for (const c of await self.clients.matchAll({ type: "window", includeUncontrolled: true })) c.postMessage({ type: "sync" });
  })());
});

// Tapping it brings the app forward, or opens it.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const scope = self.registration.scope;
    for (const c of await self.clients.matchAll({ type: "window", includeUncontrolled: true })) {
      if (c.url.startsWith(scope) && "focus" in c) { c.postMessage({ type: "sync" }); return c.focus(); }
    }
    return self.clients.openWindow(scope);
  })());
});
