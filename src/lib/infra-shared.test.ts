import { describe, expect, it } from "bun:test";

/*
 * Збірка кладе `infra.functions` у бандл двома копіями (звичайний модуль і
 * копія для server functions). Тут дві копії імітуємо імпортом з різним
 * query: кожна — окремий екземпляр модуля зі своїми `let`. Обидві мусять
 * віддати ОДИН і той самий набір функцій, тобто один стан.
 */
describe("infraShared — один стан конвеєра цілей на процес", () => {
  it("дві копії модуля віддають той самий екземпляр API", async () => {
    const a = await import("./infra.functions");
    // Шлях рядком у змінній: TypeScript не знає модуля з query, а bun знає.
    const copy = "./infra.functions.ts?copy=rpc";
    const b = (await import(copy)) as typeof a;
    expect(a).not.toBe(b);
    expect(a.infraShared()).toBe(b.infraShared());
    expect(b.infraShared().typeMemoryState).toBe(a.infraShared().typeMemoryState);
  });
});
