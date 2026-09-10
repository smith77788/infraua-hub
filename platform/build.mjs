/**
 * Збірка платформи.
 *
 * Окремий крок існує через одну річ: корінь репозиторію оголошений як
 * `"type": "module"` — цього вимагає консоль, — а платформа компілюється в
 * CommonJS. Node дивиться на найближчий package.json, тож без цього файлу
 * `platform/dist/api/server.js` вантажиться як ESM і падає на першому
 * `exports.` — саме так це й виглядало.
 *
 * Вкладений package.json з `"type": "commonjs"` ставить межу двох модульних
 * систем по каталогу. Він генерується, а не лежить у git, бо це похідне від
 * налаштувань збірки, а не те, що редагують руками.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

execFileSync("npx", ["tsc", "-p", join(here, "tsconfig.json")], { stdio: "inherit" });

const dist = join(here, "dist");
mkdirSync(dist, { recursive: true });
writeFileSync(
  join(dist, "package.json"),
  JSON.stringify({ type: "commonjs" }, null, 2) + "\n",
);
console.log("platform: скомпільовано, межу CommonJS проставлено");
