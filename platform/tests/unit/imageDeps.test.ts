import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'fs';
import { builtinModules } from 'module';
import { join } from 'path';

// Образ платформи ставить лише пакети зі списку `platform/deps.mjs`. Пакет,
// який код імпортує, а список забув, проявляється тільки при старті сервера
// вже в образі — так перша версія списку пропустила `dotenv/config`.
const PLATFORM = join(__dirname, '..', '..');
const ROOT = join(PLATFORM, '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [p] : [];
  });
}

/** Пакети, які код платформи справді вантажить: import / require / import(). */
function importedPackages(): Set<string> {
  const builtins = new Set(builtinModules);
  const out = new Set<string>();
  const re =
    /(?:^|\n)\s*(?:import|export)\s[^;]*?\sfrom\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const dir of ['core', 'agents', 'api']) {
    for (const file of sources(join(PLATFORM, dir))) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(re)) {
        const spec = m[1] ?? m[2] ?? m[3] ?? m[4] ?? '';
        if (!spec || spec.startsWith('.') || spec.startsWith('node:')) continue;
        const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!;
        if (!builtins.has(name)) out.add(name);
      }
    }
  }
  return out;
}

describe('залежності образу платформи', () => {
  it('усе, що імпортує код, є в рантайм-списку образу', async () => {
    const deps = await import(join(PLATFORM, 'deps.mjs'));
    const runtime = new Set<string>(deps.RUNTIME);
    const missing = [...importedPackages()].filter((p) => !runtime.has(p));
    expect(missing).toEqual([]);
  });

  it('версії беруться з кореневого package.json, а не дублюються', async () => {
    const deps = await import(join(PLATFORM, 'deps.mjs'));
    const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const pkg = deps.imagePackage('build', root);
    for (const [name, range] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      expect(range).toBe(root.dependencies?.[name] ?? root.devDependencies?.[name]);
    }
    // У рантаймі — без dev-частини: `--omit=dev` там більше не потрібен.
    expect(deps.imagePackage('runtime', root).devDependencies).toBeUndefined();
  });
});
