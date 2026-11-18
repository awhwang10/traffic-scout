// ==========================================================================
// Traffic Scout — Service Worker (App Shell Cache + Live Network Telemetry)
// ==========================================================================

const CACHE_NAME = "traffic-scout-shell-v1";
const APP_SHELL = [
    "./",
    "./index.html",
    "./css/tokens.css",
    "./css/components.css",
    "./js/app.js",
    "./js/config.js",
    "./js/geometry.js",
    "./js/api.js",
    "./js/map.js",
    "./js/gemini.js",
    "./manifest.json",
    "./icons/icon.svg"
];

self.addEventListener("install", event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
    );
    self.skipWaiting();
});

self.addEventListener("activate", event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys
                    .filter(key => key !== CACHE_NAME)
                    .map(key => caches.delete(key))
            )
        )
    );
    self.clients.claim();
});

self.addEventListener("fetch", event => {
    const req = event.request;
    if (req.method !== "GET") return;

    const url = new URL(req.url);

    // Always use live network for Caltrans API, camera snapshots, Google Traffic, and Gemini
    if (
        url.hostname.includes("dot.ca.gov") ||
        url.hostname.includes("google.com") ||
        url.hostname.includes("googleapis.com") ||
        url.hostname.includes("cartocdn.com")
    ) {
        return;
    }

    // Network-first with cache fallback for local app shell files so updates appear immediately
    event.respondWith(
        fetch(req)
            .then(networkRes => {
                const clone = networkRes.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
                return networkRes;
            })
            .catch(() => caches.match(req))
    );
});
