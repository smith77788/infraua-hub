import { describe, expect, it } from "bun:test";

import {
  packPointAlarms,
  parseAlertZones,
  pointKey,
  pointTransition,
  unpackPointAlarms,
  zoneAt,
  type AlertZone,
} from "./raion-alerts";

const T0 = Date.parse("2026-11-01T02:13:07Z");

/** Квадрат [lon, lat] навколо центру — як GeoJSON із detoyshahed. */
function square(lat: number, lon: number, d: number): number[][] {
  return [
    [lon - d, lat - d],
    [lon + d, lat - d],
    [lon + d, lat + d],
    [lon - d, lat + d],
    [lon - d, lat - d],
  ];
}

const payload = {
  alerts: [
    {
      api_region_id: "120",
      region_name: "Рівненський район",
      updated_at: "2026-11-01T02:13:07.649Z",
      geometry: { type: "Polygon", coordinates: [square(50.6, 26.2, 0.3)] },
    },
    {
      api_region_id: "121",
      region_name: "Сарненський район",
      updated_at: "2026-10-31T22:01:00Z",
      geometry: { type: "MultiPolygon", coordinates: [[square(51.3, 26.6, 0.3)]] },
    },
    { region_name: "битий", geometry: { type: "Polygon", coordinates: [[[1, 2]]] } },
  ],
};

describe("parseAlertZones + zoneAt — тривога в районі точки", () => {
  const zones = parseAlertZones(payload)!;

  it("розбирає Polygon і MultiPolygon, битий запис пропускає", () => {
    expect(zones.map((z) => z.name)).toEqual(["Рівненський район", "Сарненський район"]);
    expect(zones[0]!.since).toBe(Date.parse("2026-11-01T02:13:07.649Z"));
  });

  it("Рівне — у Рівненському районі, а не в Сарненському", () => {
    expect(zoneAt(50.62, 26.25, zones)?.name).toBe("Рівненський район");
    expect(zoneAt(51.34, 26.6, zones)?.name).toBe("Сарненський район");
    expect(zoneAt(49.84, 24.03, zones)).toBeNull();
  });

  it("дірка в полігоні — не тривога", () => {
    const withHole: AlertZone[] = parseAlertZones({
      alerts: [
        {
          region_name: "кільце",
          geometry: { type: "Polygon", coordinates: [square(50, 30, 1), square(50, 30, 0.2)] },
        },
      ],
    })!;
    expect(zoneAt(50, 30, withHole)).toBeNull();
    expect(zoneAt(50.5, 30, withHole)?.name).toBe("кільце");
  });

  it("не перелік — null (збій джерела, а не «тривог нема»)", () => {
    expect(parseAlertZones({ error: "x" })).toBeNull();
    expect(parseAlertZones(null)).toBeNull();
  });
});

describe("pointTransition — коли слати «тривога» і «відбій»", () => {
  const rivne: AlertZone = { id: "120", name: "Рівненський район", since: T0, polygons: [] };

  it("перше спостереження — без повідомлення (деплой посеред тривоги)", () => {
    expect(pointTransition(undefined, rivne, T0).transition).toBeNull();
    expect(pointTransition(undefined, null, T0).transition).toBeNull();
  });

  it("не було → є: тривога; є → нема: відбій із тривалістю", () => {
    const started = pointTransition({ zone: null, since: null }, rivne, T0 + 5_000);
    expect(started.transition).toEqual({ kind: "started", zone: "Рівненський район" });
    const cleared = pointTransition(started.next, null, T0 + 45 * 60_000);
    expect(cleared.transition).toEqual({
      kind: "cleared",
      zone: "Рівненський район",
      durationMs: 45 * 60_000,
    });
  });

  it("район → уся область — тривога триває, нового повідомлення нема", () => {
    const oblast: AlertZone = {
      id: "19",
      name: "Рівненська область",
      since: T0 + 60_000,
      polygons: [],
    };
    const r = pointTransition({ zone: "Рівненський район", since: T0 }, oblast, T0 + 120_000);
    expect(r.transition).toBeNull();
    expect(r.next.since).toBe(T0);
  });

  it("памʼять переживає перезапуск і не падає на сміттті", () => {
    const m = new Map([[pointKey(1, 50.62, 26.25), { zone: "Рівненський район", since: T0 }]]);
    expect(unpackPointAlarms(packPointAlarms(m))).toEqual(m);
    expect(unpackPointAlarms("не json")).toBeNull();
    expect(unpackPointAlarms(null)).toBeNull();
  });
});
