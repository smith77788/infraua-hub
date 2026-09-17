import { afterAll, describe, expect, it, setSystemTime } from "bun:test";

import { ensureNeptunStream, liveThreats, neptunStreamStatus } from "./neptun-stream";

/**
 * Фейковий WebSocket — ловимо створений інстанс, щоб керувати подіями руками.
 * Модуль читає глобальний `WebSocket` під час конекту, тож підміна глобалі до
 * `ensureNeptunStream()` спрацьовує.
 */
class FakeWS {
  static last: FakeWS | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_url: string) {
    FakeWS.last = this;
  }
  emit(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  close() {
    this.onclose?.();
  }
}

const realWS = (globalThis as { WebSocket?: unknown }).WebSocket;
(globalThis as { WebSocket?: unknown }).WebSocket = FakeWS as unknown;

afterAll(() => {
  (globalThis as { WebSocket?: unknown }).WebSocket = realWS;
  setSystemTime();
});

function threat(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    type: "uav",
    title: "БпЛА",
    locality: "Пункт",
    lat: 49.6,
    lon: 36.0,
    status: "active",
    ...over,
  };
}

describe("neptun-stream міст", () => {
  it("до снапшоту — null (часткові дані не видаємо як живі)", () => {
    ensureNeptunStream();
    FakeWS.last!.onopen?.();
    expect(liveThreats()).toBeNull();
  });

  it("снапшот повністю заміщає стан", () => {
    FakeWS.last!.emit({ type: "snapshot", data: { threats: [threat("a"), threat("b")] } });
    const live = liveThreats();
    expect(live).not.toBeNull();
    expect(live!.map((t) => t.id).sort()).toEqual(["a", "b"]);
  });

  it("upsert додає й оновлює одну ціль", () => {
    FakeWS.last!.emit({ type: "upsert", data: threat("c", { lat: 50.1 }) });
    expect(
      liveThreats()!
        .map((t) => t.id)
        .sort(),
    ).toEqual(["a", "b", "c"]);
    FakeWS.last!.emit({ type: "upsert", data: threat("a", { lat: 48.0 }) });
    const a = liveThreats()!.find((t) => t.id === "a");
    expect(a!.lat).toBe(48.0);
  });

  it("remove прибирає ціль", () => {
    FakeWS.last!.emit({ type: "remove", data: { id: "b" } });
    expect(
      liveThreats()!
        .map((t) => t.id)
        .sort(),
    ).toEqual(["a", "c"]);
  });

  it("upsert неактивної/за-межами цілі прибирає її, не лишає застиглою", () => {
    FakeWS.last!.emit({ type: "upsert", data: threat("a", { status: "expired" }) });
    expect(
      liveThreats()!
        .map((t) => t.id)
        .sort(),
    ).toEqual(["c"]);
  });

  it("heartbeat тримає свіжість, тиша довша за поріг → null (фолбек на REST)", () => {
    const t0 = Date.UTC(2026, 8, 17, 1, 0, 0);
    setSystemTime(new Date(t0));
    FakeWS.last!.emit({ type: "heartbeat" });
    expect(liveThreats()).not.toBeNull();
    // +40 с — ще свіжо
    setSystemTime(new Date(t0 + 40_000));
    expect(liveThreats()).not.toBeNull();
    // +50 с без жодного повідомлення — несвіжо
    setSystemTime(new Date(t0 + 50_000));
    expect(liveThreats()).toBeNull();
    setSystemTime();
  });

  it("статус звітує про підключення й кількість треків", () => {
    FakeWS.last!.emit({ type: "heartbeat" });
    const s = neptunStreamStatus();
    expect(s.connected).toBe(true);
    expect(s.tracks).toBe(1);
  });

  it("розрив планує перепідключення без падіння процесу", () => {
    expect(() => FakeWS.last!.close()).not.toThrow();
    // після close стан більше не «живий» до нового снапшоту
    expect(liveThreats()).toBeNull();
  });
});
