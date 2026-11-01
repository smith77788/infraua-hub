import { describe, expect, it } from "bun:test";

import {
  appendReport,
  MAX_REPORTS,
  parseReport,
  renderReportForOwner,
  ReportLimiter,
} from "./map-reports";

const NOW = Date.parse("2026-11-01T03:00:00Z");
const target = {
  id: "trk_1",
  name: "Боярка",
  type: "reactive",
  lat: 50.32,
  lon: 30.29,
  heading: 270,
  source: "neptun.in.ua",
  sources: ["kyiv_airdef"],
  lastSeen: "2026-11-01T02:58:00Z",
  typeFromChannels: true,
};

describe("parseReport — скарга з карти", () => {
  it("розбирає відому причину й знімок цілі", () => {
    const r = parseReport({ reason: "type", note: "це шахед", target }, NOW)!;
    expect(r.reason).toBe("type");
    expect(r.target.name).toBe("Боярка");
    expect(r.target.typeFromChannels).toBe(true);
  });

  it("невідома причина, нема координат, сміття — null", () => {
    expect(parseReport({ reason: "hack", target }, NOW)).toBeNull();
    expect(parseReport({ reason: "type", target: { name: "x" } }, NOW)).toBeNull();
    expect(parseReport("рядок", NOW)).toBeNull();
    expect(parseReport({ reason: "type", target: { lat: 999, lon: 30 } }, NOW)).toBeNull();
  });

  it("довгі рядки обрізаються, а HTML у тексті для Telegram екранується", () => {
    const r = parseReport({ reason: "other", note: "<b>".repeat(500), target }, NOW)!;
    expect(r.note.length).toBe(300);
    expect(renderReportForOwner(r)).not.toContain("<b><b>");
  });
});

describe("журнал і обмеження частоти", () => {
  it("тримає останні MAX_REPORTS", () => {
    let log = [] as ReturnType<typeof appendReport>;
    const r = parseReport({ reason: "ghost", target }, NOW)!;
    for (let i = 0; i < MAX_REPORTS + 5; i++) log = appendReport(log, r);
    expect(log).toHaveLength(MAX_REPORTS);
  });

  it("не більше ліміту за годину з однієї адреси", () => {
    const l = new ReportLimiter(2);
    expect(l.allow("ip", NOW)).toBe(true);
    expect(l.allow("ip", NOW)).toBe(true);
    expect(l.allow("ip", NOW)).toBe(false);
    expect(l.allow("ip", NOW + 3_700_000)).toBe(true);
  });
});
