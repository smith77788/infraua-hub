import { useEffect, useState } from "react";

/**
 * Чи є мережа — за подіями браузера `online`/`offline`.
 *
 * До монтування в браузері вважаємо, що звʼязок є: інакше сторінка, зібрана на
 * сервері, блимнула б банером «офлайн» на кожному завантаженні. Реальний стан
 * зʼявляється в першому ж ефекті.
 *
 * `navigator.onLine` не абсолют (він каже лише «є мережевий інтерфейс», а не «до
 * сервера дійде»), тож справжнім суддею застарілості лишається вік фіду — але
 * явне «офлайн» від браузера варто показати одразу, не чекаючи, поки протухне
 * останній запит.
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const sync = () => setOnline(navigator.onLine !== false);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);
  return online;
}
