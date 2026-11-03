// Minimal service worker so Chrome on Android installs the app (needed for the Share menu entry).
// It caches nothing: every request goes to the network as usual.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
