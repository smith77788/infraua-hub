import { describe, expect, it } from "bun:test";
import { publicOrigin } from "./request-origin";

const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });

describe("публічний origin за проксі", () => {
  it("бере адресу з forwarded-заголовків, а не з внутрішнього http", () => {
    // Саме цей випадок ламав вебхук: усередині http://, а публічно https://.
    const r = req("http://internal:8080/api/x", {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "infraua-hub-production.up.railway.app",
    });
    expect(publicOrigin(r)).toBe("https://infraua-hub-production.up.railway.app");
  });

  it("без проксі бере адресу самого запиту", () => {
    expect(publicOrigin(req("https://example.org/api/x"))).toBe("https://example.org");
  });

  it("forwarded-host переважає внутрішній хост навіть без forwarded-proto", () => {
    const r = req("https://internal/api/x", { "x-forwarded-host": "public.example" });
    expect(publicOrigin(r)).toBe("https://public.example");
  });
});
