/**
 * Aurora Canvas Service Worker
 * Provides offline caching for static assets and graceful degradation.
 */

const CACHE_NAME = "aurora-canvas-v1";
const STATIC_ASSETS = [
  "/canvas/",
  "/canvas/index.html",
];

// Install: cache static assets
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate: clean old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// Fetch: network-first for API, cache-first for static
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== "GET") return;

  // API/auth requests: network-only (NEVER cache sensitive data)
  if (url.pathname.startsWith("/v1/") || url.pathname.startsWith("/auth/")) {
    event.respondWith(
      fetch(request).catch(() => {
        // Return error response when offline — never serve cached API data
        return new Response(JSON.stringify({ error: "offline", message: "API unavailable offline" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      })
    );
    return;
  }

  // Static assets: cache-first
  event.respondWith(
    caches.match(request)
      .then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        });
      })
      .catch(() => {
        // Offline fallback for navigation requests
        if (request.mode === "navigate") {
          return caches.match("/canvas/index.html");
        }
        return new Response("Offline", { status: 503, statusText: "Offline" });
      })
  );
});
