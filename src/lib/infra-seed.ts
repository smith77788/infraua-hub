import type { CategoryId, Facility } from "./infra-types";

/**
 * Опорний (baseline) перелік ключових обʼєктів інфраструктури України.
 * Використовується, коли зовнішнє джерело (Overpass/OpenStreetMap) недоступне,
 * щоб консоль завжди мала змістовні дані. Координати — приблизні, публічно відомі.
 */
interface Seed {
  name: string;
  category: CategoryId;
  lat: number;
  lon: number;
  operator?: string;
  detail?: string;
}

const SEED: Seed[] = [
  // Електростанції
  {
    name: "Запорізька АЕС",
    category: "power_plant",
    lat: 47.5119,
    lon: 34.5859,
    operator: "Енергоатом",
    detail: "джерело: nuclear",
  },
  {
    name: "Південноукраїнська АЕС",
    category: "power_plant",
    lat: 47.8122,
    lon: 31.22,
    operator: "Енергоатом",
    detail: "джерело: nuclear",
  },
  {
    name: "Рівненська АЕС",
    category: "power_plant",
    lat: 51.3275,
    lon: 25.8894,
    operator: "Енергоатом",
    detail: "джерело: nuclear",
  },
  {
    name: "Хмельницька АЕС",
    category: "power_plant",
    lat: 50.302,
    lon: 26.6486,
    operator: "Енергоатом",
    detail: "джерело: nuclear",
  },
  {
    name: "Дніпровська ГЕС (ДніпроГЕС)",
    category: "power_plant",
    lat: 47.8686,
    lon: 35.087,
    operator: "Укргідроенерго",
    detail: "джерело: hydro",
  },
  {
    name: "Кременчуцька ГЕС",
    category: "power_plant",
    lat: 49.076,
    lon: 33.25,
    operator: "Укргідроенерго",
    detail: "джерело: hydro",
  },
  {
    name: "Канівська ГЕС",
    category: "power_plant",
    lat: 49.766,
    lon: 31.468,
    operator: "Укргідроенерго",
    detail: "джерело: hydro",
  },
  {
    name: "Дністровська ГЕС",
    category: "power_plant",
    lat: 48.517,
    lon: 27.47,
    operator: "Укргідроенерго",
    detail: "джерело: hydro",
  },
  {
    name: "Бурштинська ТЕС",
    category: "power_plant",
    lat: 49.1936,
    lon: 24.6386,
    operator: "ДТЕК",
    detail: "джерело: coal",
  },
  {
    name: "Зміївська ТЕС",
    category: "power_plant",
    lat: 49.582,
    lon: 36.546,
    operator: "Центренерго",
    detail: "джерело: coal",
  },
  {
    name: "Трипільська ТЕС",
    category: "power_plant",
    lat: 50.133,
    lon: 30.766,
    operator: "Центренерго",
    detail: "джерело: coal",
  },
  {
    name: "Ладижинська ТЕС",
    category: "power_plant",
    lat: 48.68,
    lon: 29.23,
    operator: "ДТЕК",
    detail: "джерело: coal",
  },
  {
    name: "Криворізька ТЕС",
    category: "power_plant",
    lat: 47.556,
    lon: 33.656,
    operator: "ДТЕК",
    detail: "джерело: coal",
  },
  {
    name: "Добротвірська ТЕС",
    category: "power_plant",
    lat: 50.22,
    lon: 24.38,
    operator: "ДТЕК",
    detail: "джерело: coal",
  },

  // Підстанції 110кВ+
  {
    name: "ПС 750 кВ Київська",
    category: "substation",
    lat: 50.545,
    lon: 30.79,
    operator: "Укренерго",
    detail: "750 кВ",
  },
  {
    name: "ПС 750 кВ Західноукраїнська",
    category: "substation",
    lat: 49.83,
    lon: 24.05,
    operator: "Укренерго",
    detail: "750 кВ",
  },
  {
    name: "ПС 750 кВ Дніпровська",
    category: "substation",
    lat: 48.52,
    lon: 35.02,
    operator: "Укренерго",
    detail: "750 кВ",
  },
  {
    name: "ПС 750 кВ Південноукраїнська",
    category: "substation",
    lat: 47.81,
    lon: 31.25,
    operator: "Укренерго",
    detail: "750 кВ",
  },
  {
    name: "ПС 330 кВ Одеська",
    category: "substation",
    lat: 46.47,
    lon: 30.63,
    operator: "Укренерго",
    detail: "330 кВ",
  },
  {
    name: "ПС 330 кВ Харківська",
    category: "substation",
    lat: 49.98,
    lon: 36.35,
    operator: "Укренерго",
    detail: "330 кВ",
  },

  // Водоканали
  {
    name: "Дніпровська водопровідна станція",
    category: "water",
    lat: 50.472,
    lon: 30.6,
    operator: "Київводоканал",
  },
  {
    name: "Деснянська водопровідна станція",
    category: "water",
    lat: 50.55,
    lon: 30.62,
    operator: "Київводоканал",
  },
  {
    name: "Харківводоканал",
    category: "water",
    lat: 49.99,
    lon: 36.23,
    operator: "Харківводоканал",
  },
  {
    name: "Інфоксводоканал (Одеса)",
    category: "water",
    lat: 46.47,
    lon: 30.73,
    operator: "Інфокс",
  },
  {
    name: "Дніпроводоканал",
    category: "water",
    lat: 48.46,
    lon: 35.04,
    operator: "Дніпроводоканал",
  },
  { name: "Львівводоканал", category: "water", lat: 49.84, lon: 24.03, operator: "Львівводоканал" },

  // Лікарні
  {
    name: "Охматдит (Київ)",
    category: "hospital",
    lat: 50.4495,
    lon: 30.4699,
    detail: "приймальне відділення",
  },
  {
    name: "Олександрівська лікарня (Київ)",
    category: "hospital",
    lat: 50.4432,
    lon: 30.5262,
    detail: "приймальне відділення",
  },
  {
    name: "Львівська обласна клінічна лікарня",
    category: "hospital",
    lat: 49.84,
    lon: 24.03,
    detail: "приймальне відділення",
  },
  {
    name: "Одеська обласна клінічна лікарня",
    category: "hospital",
    lat: 46.472,
    lon: 30.73,
    detail: "приймальне відділення",
  },
  {
    name: "Харківська обласна клінічна лікарня",
    category: "hospital",
    lat: 49.99,
    lon: 36.23,
    detail: "приймальне відділення",
  },
  {
    name: "Дніпровська обласна клінічна лікарня ім. Мечникова",
    category: "hospital",
    lat: 48.462,
    lon: 35.045,
    detail: "приймальне відділення",
  },

  // Аеродроми
  {
    name: "Міжнародний аеропорт «Бориспіль»",
    category: "airport",
    lat: 50.345,
    lon: 30.8947,
    detail: "IATA KBP",
  },
  {
    name: "Аеропорт «Київ» (Жуляни)",
    category: "airport",
    lat: 50.4017,
    lon: 30.4519,
    detail: "IATA IEV",
  },
  {
    name: "Міжнародний аеропорт «Львів»",
    category: "airport",
    lat: 49.8125,
    lon: 23.9561,
    detail: "IATA LWO",
  },
  {
    name: "Міжнародний аеропорт «Одеса»",
    category: "airport",
    lat: 46.4268,
    lon: 30.6765,
    detail: "IATA ODS",
  },
  {
    name: "Міжнародний аеропорт «Харків»",
    category: "airport",
    lat: 49.9248,
    lon: 36.29,
    detail: "IATA HRK",
  },
  {
    name: "Аеропорт «Дніпро»",
    category: "airport",
    lat: 48.3572,
    lon: 35.1006,
    detail: "IATA DNK",
  },
  {
    name: "Міжнародний аеропорт «Запоріжжя»",
    category: "airport",
    lat: 47.858,
    lon: 35.3157,
    detail: "IATA OZH",
  },

  // Залізничні вузли
  {
    name: "Станція Київ-Пасажирський",
    category: "rail",
    lat: 50.44,
    lon: 30.489,
    operator: "Укрзалізниця",
  },
  { name: "Станція Львів", category: "rail", lat: 49.8397, lon: 23.994, operator: "Укрзалізниця" },
  {
    name: "Станція Харків-Пасажирський",
    category: "rail",
    lat: 49.9935,
    lon: 36.261,
    operator: "Укрзалізниця",
  },
  {
    name: "Станція Одеса-Головна",
    category: "rail",
    lat: 46.46,
    lon: 30.73,
    operator: "Укрзалізниця",
  },
  {
    name: "Станція Дніпро-Головний",
    category: "rail",
    lat: 48.478,
    lon: 35.035,
    operator: "Укрзалізниця",
  },
  { name: "Станція Вінниця", category: "rail", lat: 49.23, lon: 28.47, operator: "Укрзалізниця" },

  // Вузли звʼязку
  { name: "Київська телевежа", category: "telecom", lat: 50.4682, lon: 30.455 },
  { name: "Харківська телевежа", category: "telecom", lat: 50.006, lon: 36.232 },
  { name: "Львівська РТПС", category: "telecom", lat: 49.83, lon: 24.03 },
  { name: "Карпатська РТПС (Красна)", category: "telecom", lat: 48.16, lon: 24.5 },
];

/** Опорні обʼєкти у форматі Facility зі стабільними id та посиланням на OSM-координати. */
export const SEED_FACILITIES: Facility[] = SEED.map((s, i) => ({
  id: `seed/${s.category}/${i}`,
  name: s.name,
  category: s.category,
  lat: s.lat,
  lon: s.lon,
  ...(s.operator ? { operator: s.operator } : {}),
  ...(s.detail ? { detail: s.detail } : {}),
  source: `https://www.openstreetmap.org/#map=14/${s.lat}/${s.lon}`,
}));
