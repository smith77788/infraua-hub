/*
 * Service worker — щоб радар ВІДКРИВАВСЯ офлайн.
 *
 * Наліт і погана мережа приходять разом. react-query й локальний знімок
 * рятують уже відкриту вкладку; цей worker рятує ХОЛОДНИЙ старт — коли вкладку
 * відкривають знову без мережі. Він кешує лише ОБОЛОНКУ (HTML-каркас і хешовану
 * статику), а не дані.
 *
 * Головне правило безпеки: /api/* НЕ кешуємо ніколи. Свіжість повітряної
 * картини вирішує застосунок (банер стану + вік знімка), а не кеш. Віддати
 * застиглі дані за поточні в цьому інструменті — гірше за порожній екран.
 */

const VERSION = "infraua-shell-v1";

self.addEventListener("install", () => {
  // Нова версія готова одразу: тримати стару оболонку немає сенсу.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return; // чужий origin — не наша справа
  if (url.pathname.startsWith("/api/")) return; // ДАНІ НЕ КЕШУЄМО

  // Навігація (HTML): мережа спершу, оболонка з кешу — запасний варіант, щоб
  // сторінка бодай відкрилась офлайн. Кешована HTML легка: дані вантажаться
  // окремими запитами, тож застиглих чисел вона в собі не несе.
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const net = await fetch(req);
          const cache = await caches.open(VERSION);
          cache.put("/", net.clone());
          return net;
        } catch {
          const cache = await caches.open(VERSION);
          return (
            (await cache.match("/")) ??
            (await cache.match(req)) ??
            new Response("Офлайн — відкрийте, коли зʼявиться звʼязок.", {
              status: 503,
              headers: { "content-type": "text/plain; charset=utf-8" },
            })
          );
        }
      })(),
    );
    return;
  }

  // Хешована статика (скрипти, стилі, шрифти, зображення): stale-while-revalidate.
  // Імена файлів несуть хеш, тож старе не видасться за нове помилково.
  if (["script", "style", "font", "image"].includes(req.destination)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(VERSION);
        const cached = await cache.match(req);
        const network = fetch(req)
          .then((res) => {
            if (res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => cached);
        return cached ?? network;
      })(),
    );
  }
});
