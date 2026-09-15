/**
 * Реєстрація service worker — лише в браузері й лише в проді.
 *
 * У режимі розробки SW заважає гарячому перезавантаженню й кешує те, що ти
 * щойно змінив, тож там його свідомо немає. Помилка реєстрації нічого не
 * ламає: без worker-а застосунок просто працює як завжди, лише не відкривається
 * офлайн.
 */
export function registerServiceWorker(): void {
  if (typeof window === "undefined") return;
  if (!("serviceWorker" in navigator)) return;
  // Vite підставляє це значення на збірці; у dev — false.
  if (!import.meta.env.PROD) return;

  const register = () => {
    navigator.serviceWorker
      .register("/sw.js")
      .catch((err) => console.error("service worker register failed", err));
  };
  // Після load, щоб реєстрація не конкурувала за мережу з першим малюванням.
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}
