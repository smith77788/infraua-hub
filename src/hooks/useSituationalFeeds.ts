import { useServerFn } from "@tanstack/react-start";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import type { FirePoint, FrontlineArea, WeatherNow } from "@/lib/air";
import { ageOf } from "@/lib/freshness";
import { statusOf, type SourceStatus } from "@/lib/sources";
import {
  getFires,
  getFrontline,
  getInternetOutages,
  getSpaceWeather,
  getWeather,
  type InternetOutages,
  type SpaceWeather,
} from "@/lib/infra.functions";

/*
 * Ситуаційний data-plane консолі в одному місці.
 *
 * Фонові фіди (лінія фронту, пожежі, космічна погода, інтернет-збої, погода)
 * розповзлися окремими useQuery по маршруту-god-компоненту. Тут вони зібрані в
 * один хук: маршрут отримує готові дані, а додати наступний фід — це один блок
 * тут, а не ще один шматок логіки в 1500-рядковому компоненті. Кожен фід
 * оновлюється рідко (це фон, не бойова обстановка), тож інтервали довгі.
 */
export interface SituationalFeeds {
  frontline: FrontlineArea[];
  fires: FirePoint[];
  spaceWeather: SpaceWeather | undefined;
  outages: InternetOutages | undefined;
  weather: WeatherNow | undefined;
  /** Стан кожного фіду — для єдиної панелі спостережуваності data-plane. */
  statuses: SourceStatus[];
}

const SLOW = 20 * 60 * 1000;

/** Свіжість фонового фіду за часом останнього успішного завантаження. */
function feedStatus(
  id: string,
  label: string,
  count: number,
  q: UseQueryResult<{ degraded?: boolean } | undefined>,
): SourceStatus {
  const iso = q.dataUpdatedAt ? new Date(q.dataUpdatedAt).toISOString() : null;
  return statusOf({
    id,
    label,
    count,
    age: ageOf(iso, 60, 180),
    ...(q.data?.degraded ? { degraded: true } : {}),
  });
}

export function useSituationalFeeds(): SituationalFeeds {
  const frontlineFn = useServerFn(getFrontline);
  const firesFn = useServerFn(getFires);
  const spaceWeatherFn = useServerFn(getSpaceWeather);
  const outagesFn = useServerFn(getInternetOutages);
  const weatherFn = useServerFn(getWeather);

  const frontlineQ = useQuery({
    queryKey: ["frontline"],
    queryFn: () => frontlineFn(),
    staleTime: 30 * 60 * 1000,
    refetchInterval: 30 * 60 * 1000,
  });
  const firesQ = useQuery({
    queryKey: ["fires"],
    queryFn: () => firesFn(),
    staleTime: SLOW,
    refetchInterval: SLOW,
  });
  const spaceWeatherQ = useQuery({
    queryKey: ["space-weather"],
    queryFn: () => spaceWeatherFn(),
    staleTime: SLOW,
    refetchInterval: SLOW,
  });
  const outagesQ = useQuery({
    queryKey: ["internet-outages"],
    queryFn: () => outagesFn(),
    staleTime: 10 * 60 * 1000,
    refetchInterval: 10 * 60 * 1000,
  });
  const weatherQ = useQuery({
    queryKey: ["weather"],
    queryFn: () => weatherFn(),
    staleTime: 15 * 60 * 1000,
    refetchInterval: 15 * 60 * 1000,
  });

  const frontline = frontlineQ.data?.areas ?? [];
  const fires = firesQ.data?.fires ?? [];
  return {
    frontline,
    fires,
    spaceWeather: spaceWeatherQ.data,
    outages: outagesQ.data,
    weather: weatherQ.data,
    statuses: [
      feedStatus("frontline", "Окупована територія (DeepState)", frontline.length, frontlineQ),
      feedStatus("fires", "Пожежі (NASA FIRMS)", fires.length, firesQ),
      feedStatus(
        "spaceweather",
        "Космічна погода (NOAA)",
        spaceWeatherQ.data ? 1 : 0,
        spaceWeatherQ,
      ),
      feedStatus("ioda", "Інтернет-збої (IODA)", outagesQ.data?.count ?? 0, outagesQ),
      feedStatus("weather", "Погода (open-meteo)", weatherQ.data ? 1 : 0, weatherQ),
    ],
  };
}
