import { describe, expect, it } from "bun:test";
import {
  decideChannelAction,
  HEARTBEAT_MS,
  LIVE_POST_MAX_MS,
  MIN_TOUCH_MS,
  type CadenceInput,
} from "./channel-cadence";

const T0 = Date.parse("2026-09-18T20:00:00Z");

function input(over: Partial<CadenceInput> = {}): CadenceInput {
  return {
    now: T0,
    signature: "Харківщина:shahed:3",
    lastSignature: "Харківщина:shahed:3",
    lastTouchAt: T0 - 10 * 60_000,
    livePostAt: T0 - 10 * 60_000,
    messageId: 42,
    escalation: [],
    ...over,
  };
}

describe("мовчання", () => {
  it("нічого не змінилось і ознака життя свіжа — мовчимо", () => {
    const d = decideChannelAction(input());
    expect(d.action).toBe("silent");
    expect(d.reason).toBe("без суттєвих змін");
  });

  it("картина змінилась, але щойно оновлювали — мовчимо", () => {
    const d = decideChannelAction(
      input({ signature: "Харківщина:shahed:4", lastTouchAt: T0 - MIN_TOUCH_MS + 1000 }),
    );
    expect(d.action).toBe("silent");
    expect(d.reason).toBe("щойно оновлювали");
  });

  it("порогу дотику рівно досить — уже не мовчимо", () => {
    const d = decideChannelAction(
      input({ signature: "Харківщина:shahed:4", lastTouchAt: T0 - MIN_TOUCH_MS }),
    );
    expect(d.action).toBe("edit");
  });
});

describe("правка живого поста", () => {
  it("картина змінилась — правимо, у стрічці нічого не зʼявляється", () => {
    const d = decideChannelAction(input({ signature: "Харківщина:shahed:9" }));
    expect(d.action).toBe("edit");
    expect(d.reason).toBe("картина змінилась");
  });

  it("нічого не змінилось, але живий пост давно мовчить — торкаємось заради ознаки життя", () => {
    const d = decideChannelAction(input({ lastTouchAt: T0 - HEARTBEAT_MS }));
    expect(d.action).toBe("edit");
    expect(d.reason).toBe("ознака життя");
  });
});

describe("новий пост", () => {
  it("живого поста немає — постимо", () => {
    const d = decideChannelAction(input({ messageId: null, signature: "Сумщина:shahed:1" }));
    expect(d.action).toBe("post");
    expect(d.reason).toBe("немає живого поста");
  });

  it("живий пост похований у стрічці — новий, а не правка", () => {
    const d = decideChannelAction(
      input({ signature: "Сумщина:shahed:1", livePostAt: T0 - LIVE_POST_MAX_MS - 1 }),
    );
    expect(d.action).toBe("post");
    expect(d.reason).toBe("живий пост застарів");
  });

  it("новий критичний тип — новий пост, навіть коли живий є і свіжий", () => {
    const d = decideChannelAction(input({ escalation: ["ballistic"] }));
    expect(d.action).toBe("post");
    expect(d.reason).toContain("ballistic");
  });

  it("ескалація проходить повз поріг частоти", () => {
    const d = decideChannelAction(input({ escalation: ["ballistic"], lastTouchAt: T0 - 1000 }));
    expect(d.action).toBe("post");
  });

  it("ручний виклик дає новий пост, а не тиху правку", () => {
    const d = decideChannelAction(input({ force: true, lastTouchAt: T0 - 1000 }));
    expect(d.action).toBe("post");
    expect(d.reason).toBe("викликано вручну");
  });
});

describe("частота за годину безперервного нальоту", () => {
  /*
   * Це замір, а не приклад: скарга була саме на частоту. Тик — кожні 5 хвилин
   * (крок планувальника каналу), кількість цілей дрижить на кожному тику, як
   * у справжньому фіді, ескалацій немає — сама по собі зміна лічильника не
   * повинна давати жодного НОВОГО поста.
   */
  it("дрижання лічильника не дає жодного нового поста за годину", () => {
    let lastTouchAt = T0;
    let livePostAt = T0;
    let lastSignature = "Харківщина:shahed:10";
    let posts = 0;
    let edits = 0;
    for (let i = 1; i <= 12; i++) {
      const now = T0 + i * 5 * 60_000;
      const signature = `Харківщина:shahed:${10 + (i % 4)}`;
      const d = decideChannelAction({
        now,
        signature,
        lastSignature,
        lastTouchAt,
        livePostAt,
        messageId: 42,
        escalation: [],
      });
      if (d.action === "silent") continue;
      lastTouchAt = now;
      lastSignature = signature;
      if (d.action === "post") {
        posts++;
        livePostAt = now;
      } else edits++;
    }
    expect(posts).toBe(1); // рівно один: коли живому посту стукнуло 45 хв
    expect(edits).toBeGreaterThan(0);
  });
});
