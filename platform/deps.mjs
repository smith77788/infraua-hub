/**
 * Залежності образу платформи — лише її власні, з версіями з кореневого
 * package.json.
 *
 * Корінь оголошує ~80 пакетів, і майже всі — консолі (react, tanstack,
 * leaflet…). Образ платформи ставив їх усі, і саме на цьому дереві впала
 * збірка platform-api 20.10.2026: крок `[runtime 4/6] RUN npm install
 * --omit=dev`, npm 10.8.2 з `node:20-alpine`, «Cannot read properties of null
 * (reading 'edgesOut')» — падіння його побудовника дерева. Відтворити поза
 * образом не вдалося (та сама команда на npm 10.8.2 під node 22 тут проходить),
 * тож це не «знайдена причина». Але платформі ці ~360 пакетів не потрібні
 * зовсім: вона імпортує чотири. Менше дерево — менше місця, де npm може
 * спіткнутися, і швидша збірка.
 *
 * Версії не дублюються тут, а беруться з кореня: розсинхрон двох списків уже
 * раз заморозив прод на добу (bun.lock, 16.09). Пакет, якого в корені немає, —
 * помилка збірки, а не тихий пропуск.
 *
 *   node platform/deps.mjs build    → для компіляції (з typescript і @types)
 *   node platform/deps.mjs runtime  → для запуску
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Що платформа імпортує в рантаймі (`platform/{core,agents,api}`). Повноту
 * списку стереже `platform/tests/image-deps.test.ts`: пропущений тут пакет
 * (як `dotenv/config` у першій версії) валить сервер при старті вже в образі.
 */
export const RUNTIME = ["express", "cors", "uuid", "dotenv", "@anthropic-ai/sdk"];
/** Що потрібно `tsc -p platform/tsconfig.json` (types: node, bun). */
export const BUILD = [
  "typescript",
  "@types/node",
  "@types/express",
  "@types/cors",
  "@types/uuid",
  "@types/bun",
];

/** package.json образу для `build` чи `runtime`. */
export function imagePackage(mode, root) {
  const declared = { ...root.dependencies, ...root.devDependencies };
  const pick = (names) => {
    const out = {};
    for (const n of names) {
      if (!declared[n]) throw new Error(`«${n}» не оголошений у кореневому package.json`);
      out[n] = declared[n];
    }
    return out;
  };
  return {
    name: "infraua-platform-image",
    private: true,
    dependencies: pick(RUNTIME),
    ...(mode === "build" ? { devDependencies: pick(BUILD) } : {}),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const mode = process.argv[2];
  if (mode !== "build" && mode !== "runtime") {
    console.error("використання: node platform/deps.mjs build|runtime");
    process.exit(2);
  }
  const root = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
  );
  try {
    process.stdout.write(JSON.stringify(imagePackage(mode, root), null, 2) + "\n");
  } catch (e) {
    console.error(`platform/deps.mjs: ${e.message}`);
    process.exit(1);
  }
}
