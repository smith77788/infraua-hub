import { useEffect, useRef, useState } from "react";

import {
  addObservation,
  detectSurge,
  type ActivityBucket,
  type SurgeResult,
} from "@/lib/air-anomaly";

/*
 * Накопичує історію повітряної активності на пристрої й повертає рівень сплеску.
 *
 * Консоль стежить за небом покадрово (опитування раз на ~30 с), але «скільки
 * цілей зараз» без норми ні про що не каже. Цей хук збирає пік активності по
 * 10-хвилинних відрах у localStorage — історія переживає перезавантаження на
 * тому ж пристрої — і рахує, чи поточне значення різко вище за власну норму.
 *
 * Це клієнтська, подомашня історія. Кросдевайсна багатоденна база — наступний
 * крок на постійному томі платформи (той самий чистий розрахунок air-anomaly).
 */

const LS_KEY = "infraua.air-activity.v1";

function load(): ActivityBucket[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (b): b is ActivityBucket =>
        !!b &&
        typeof b === "object" &&
        typeof (b as ActivityBucket).t === "number" &&
        typeof (b as ActivityBucket).count === "number",
    );
  } catch {
    return [];
  }
}

function save(buckets: ActivityBucket[]) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(buckets));
  } catch {
    /* приватний режим / немає сховища — просто не памʼятаємо */
  }
}

/**
 * @param count поточна кількість активних повітряних цілей
 * @param enabled поки false (напр. дані ще вантажаться) історія не пишеться
 */
export function useAirActivityHistory(count: number, enabled = true): SurgeResult {
  const [buckets, setBuckets] = useState<ActivityBucket[]>([]);
  const hydrated = useRef(false);

  // Гідратуємо зі сховища лише на клієнті — на сервері localStorage немає.
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    setBuckets(load());
  }, []);

  useEffect(() => {
    if (!enabled || !hydrated.current || !Number.isFinite(count)) return;
    setBuckets((prev) => {
      const next = addObservation(prev, count, Date.now());
      save(next);
      return next;
    });
  }, [count, enabled]);

  return detectSurge(buckets, Date.now());
}
