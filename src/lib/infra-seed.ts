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
  { name: "Одеська РТПС", category: "telecom", lat: 46.47, lon: 30.74 },
  { name: "Дніпровська РТПС", category: "telecom", lat: 48.46, lon: 35.05 },
  { name: "Вінницька РТПС", category: "telecom", lat: 49.23, lon: 28.48 },
  { name: "Полтавська РТПС", category: "telecom", lat: 49.59, lon: 34.55 },

  // Обласні клінічні лікарні (додатково)
  {
    name: "Полтавська обласна клінічна лікарня",
    category: "hospital",
    lat: 49.588,
    lon: 34.551,
    detail: "приймальне відділення",
  },
  {
    name: "Чернігівська обласна лікарня",
    category: "hospital",
    lat: 51.494,
    lon: 31.294,
    detail: "приймальне відділення",
  },
  {
    name: "Сумська обласна клінічна лікарня",
    category: "hospital",
    lat: 50.907,
    lon: 34.799,
    detail: "приймальне відділення",
  },
  {
    name: "Житомирська обласна клінічна лікарня",
    category: "hospital",
    lat: 50.254,
    lon: 28.658,
    detail: "приймальне відділення",
  },
  {
    name: "Черкаська обласна лікарня",
    category: "hospital",
    lat: 49.444,
    lon: 32.059,
    detail: "приймальне відділення",
  },
  {
    name: "Кіровоградська обласна лікарня (Кропивницький)",
    category: "hospital",
    lat: 48.507,
    lon: 32.262,
    detail: "приймальне відділення",
  },
  {
    name: "Миколаївська обласна лікарня",
    category: "hospital",
    lat: 46.967,
    lon: 31.996,
    detail: "приймальне відділення",
  },
  {
    name: "Херсонська обласна клінічна лікарня",
    category: "hospital",
    lat: 46.641,
    lon: 32.626,
    detail: "приймальне відділення",
  },
  {
    name: "Тернопільська університетська лікарня",
    category: "hospital",
    lat: 49.554,
    lon: 25.595,
    detail: "приймальне відділення",
  },
  {
    name: "Волинська обласна лікарня (Луцьк)",
    category: "hospital",
    lat: 50.747,
    lon: 25.325,
    detail: "приймальне відділення",
  },
  {
    name: "Закарпатська обласна лікарня (Ужгород)",
    category: "hospital",
    lat: 48.621,
    lon: 22.288,
    detail: "приймальне відділення",
  },
  {
    name: "Чернівецька обласна лікарня",
    category: "hospital",
    lat: 48.291,
    lon: 25.935,
    detail: "приймальне відділення",
  },
  {
    name: "Хмельницька обласна лікарня",
    category: "hospital",
    lat: 49.42,
    lon: 26.987,
    detail: "приймальне відділення",
  },
  {
    name: "Рівненська обласна лікарня",
    category: "hospital",
    lat: 50.62,
    lon: 26.251,
    detail: "приймальне відділення",
  },
  {
    name: "Івано-Франківська обласна лікарня",
    category: "hospital",
    lat: 48.922,
    lon: 24.711,
    detail: "приймальне відділення",
  },

  // Підстанції 330/750 кВ (додатково)
  {
    name: "ПС 750 кВ Вінницька (Немирів)",
    category: "substation",
    lat: 48.97,
    lon: 28.84,
    operator: "Укренерго",
    detail: "750 кВ",
  },
  {
    name: "ПС 330 кВ Чернігівська",
    category: "substation",
    lat: 51.49,
    lon: 31.29,
    operator: "Укренерго",
    detail: "330 кВ",
  },
  {
    name: "ПС 330 кВ Полтавська",
    category: "substation",
    lat: 49.59,
    lon: 34.55,
    operator: "Укренерго",
    detail: "330 кВ",
  },
  {
    name: "ПС 330 кВ Львівська",
    category: "substation",
    lat: 49.84,
    lon: 24.03,
    operator: "Укренерго",
    detail: "330 кВ",
  },
  {
    name: "ПС 330 кВ Миколаївська",
    category: "substation",
    lat: 46.97,
    lon: 32.0,
    operator: "Укренерго",
    detail: "330 кВ",
  },

  // Водоканали (додатково)
  {
    name: "Вінницяоблводоканал",
    category: "water",
    lat: 49.233,
    lon: 28.468,
    operator: "Вінницяоблводоканал",
  },
  {
    name: "Полтававодоканал",
    category: "water",
    lat: 49.588,
    lon: 34.551,
    operator: "Полтававодоканал",
  },
  {
    name: "Запоріжжяводоканал",
    category: "water",
    lat: 47.838,
    lon: 35.14,
    operator: "Запоріжжяводоканал",
  },
  {
    name: "Миколаївводоканал",
    category: "water",
    lat: 46.967,
    lon: 31.996,
    operator: "Миколаївводоканал",
  },

  // Залізничні вузли (додатково)
  { name: "Станція Козятин", category: "rail", lat: 49.716, lon: 28.837, operator: "Укрзалізниця" },
  {
    name: "Станція Здолбунів",
    category: "rail",
    lat: 50.516,
    lon: 26.24,
    operator: "Укрзалізниця",
  },
  {
    name: "Станція Полтава-Київська",
    category: "rail",
    lat: 49.603,
    lon: 34.529,
    operator: "Укрзалізниця",
  },
  {
    name: "Станція Запоріжжя-1",
    category: "rail",
    lat: 47.837,
    lon: 35.139,
    operator: "Укрзалізниця",
  },

  // Нафта і газ
  {
    name: "Кременчуцький НПЗ (Укртатнафта)",
    category: "oil_gas",
    lat: 49.05,
    lon: 33.44,
    operator: "Укртатнафта",
    detail: "нафтопереробка",
  },
  {
    name: "Дрогобицький НПЗ",
    category: "oil_gas",
    lat: 49.35,
    lon: 23.51,
    detail: "нафтопереробка",
  },
  {
    name: "Шебелинський ГПЗ",
    category: "oil_gas",
    lat: 49.62,
    lon: 36.3,
    operator: "Укргазвидобування",
    detail: "газопереробка",
  },
  {
    name: "ПСГ Більче-Волицько-Угерське",
    category: "oil_gas",
    lat: 49.3,
    lon: 23.5,
    operator: "Укртрансгаз",
    detail: "підземне сховище газу",
  },
  {
    name: "Дашавське ПСГ",
    category: "oil_gas",
    lat: 49.35,
    lon: 23.87,
    operator: "Укртрансгаз",
    detail: "підземне сховище газу",
  },
  { name: "Одеська нафтобаза", category: "oil_gas", lat: 46.5, lon: 30.75, detail: "нафтобаза" },

  // Греблі / ГТС
  {
    name: "Гребля Київської ГЕС (Вишгород)",
    category: "dam",
    lat: 50.6,
    lon: 30.5,
    operator: "Укргідроенерго",
  },
  {
    name: "Гребля Кременчуцької ГЕС",
    category: "dam",
    lat: 49.076,
    lon: 33.25,
    operator: "Укргідроенерго",
  },
  {
    name: "Гребля Дністровської ГЕС",
    category: "dam",
    lat: 48.517,
    lon: 27.47,
    operator: "Укргідроенерго",
  },
  {
    name: "Гребля Канівської ГЕС",
    category: "dam",
    lat: 49.766,
    lon: 31.468,
    operator: "Укргідроенерго",
  },
  {
    name: "Гребля ДніпроГЕС",
    category: "dam",
    lat: 47.868,
    lon: 35.087,
    operator: "Укргідроенерго",
  },

  // Пожежні частини (ДСНС)
  { name: "ГУ ДСНС у м. Києві", category: "fire_station", lat: 50.447, lon: 30.52 },
  { name: "ГУ ДСНС у Львівській області", category: "fire_station", lat: 49.84, lon: 24.03 },
  { name: "ГУ ДСНС у Харківській області", category: "fire_station", lat: 49.99, lon: 36.23 },
  { name: "ГУ ДСНС в Одеській області", category: "fire_station", lat: 46.47, lon: 30.73 },
  { name: "ГУ ДСНС у Дніпропетровській області", category: "fire_station", lat: 48.46, lon: 35.04 },

  // Морські порти
  { name: "Одеський морський порт", category: "seaport", lat: 46.49, lon: 30.74, operator: "АМПУ" },
  {
    name: "Порт «Південний» (Південне)",
    category: "seaport",
    lat: 46.63,
    lon: 31.02,
    operator: "АМПУ",
  },
  { name: "Порт «Чорноморськ»", category: "seaport", lat: 46.3, lon: 30.66, operator: "АМПУ" },
  {
    name: "Миколаївський морський порт",
    category: "seaport",
    lat: 46.95,
    lon: 32.02,
    operator: "АМПУ",
  },
  { name: "Ізмаїльський порт", category: "seaport", lat: 45.35, lon: 28.84, operator: "АМПУ" },
  { name: "Порт Рені", category: "seaport", lat: 45.45, lon: 28.28, operator: "АМПУ" },

  // Пункти пропуску
  { name: "ПП «Краковець» (UA–PL)", category: "border", lat: 49.96, lon: 23.18 },
  { name: "ПП «Шегині» (UA–PL)", category: "border", lat: 49.79, lon: 22.99 },
  { name: "ПП «Ягодин» (UA–PL)", category: "border", lat: 51.05, lon: 23.83 },
  { name: "ПП «Чоп / Тиса» (UA–HU)", category: "border", lat: 48.43, lon: 22.2 },
  { name: "ПП «Порубне» (UA–RO)", category: "border", lat: 48.09, lon: 26.1 },
  { name: "ПП «Паланка» (UA–MD)", category: "border", lat: 46.27, lon: 29.98 },

  // Центри обробки даних
  { name: "ЦОД De Novo (Київ)", category: "data_center", lat: 50.4, lon: 30.52 },
  { name: "ЦОД Datagroup (Київ)", category: "data_center", lat: 50.45, lon: 30.48 },
  { name: "ЦОД GigaCenter (Київ)", category: "data_center", lat: 50.43, lon: 30.55 },
  { name: "ЦОД (Харків)", category: "data_center", lat: 49.99, lon: 36.23 },
  { name: "ЦОД (Львів)", category: "data_center", lat: 49.84, lon: 24.03 },

  // Держустанови
  { name: "Верховна Рада України", category: "government", lat: 50.4456, lon: 30.5461 },
  { name: "Кабінет Міністрів України", category: "government", lat: 50.4479, lon: 30.5374 },
  { name: "Офіс Президента України", category: "government", lat: 50.4492, lon: 30.537 },
  { name: "Національний банк України", category: "government", lat: 50.4472, lon: 30.5353 },
  { name: "Львівська ОВА", category: "government", lat: 49.842, lon: 24.031 },
  { name: "Харківська ОВА", category: "government", lat: 49.993, lon: 36.231 },
  { name: "Одеська ОВА", category: "government", lat: 46.484, lon: 30.727 },
  { name: "Дніпропетровська ОВА", category: "government", lat: 48.465, lon: 35.046 },

  // Елеватори / зерносховища
  {
    name: "Зерновий термінал «Нібулон» (Миколаїв)",
    category: "grain",
    lat: 46.96,
    lon: 31.98,
    operator: "Нібулон",
  },
  { name: "Одеський зерновий термінал", category: "grain", lat: 46.49, lon: 30.74 },
  { name: "Чорноморський зерновий термінал", category: "grain", lat: 46.3, lon: 30.66 },
  {
    name: "Елеватор Kernel (Полтавщина)",
    category: "grain",
    lat: 49.6,
    lon: 34.4,
    operator: "Kernel",
  },
  { name: "Елеватор (Тернопільщина)", category: "grain", lat: 49.55, lon: 25.6 },

  // Промислові вузли
  {
    name: "АрселорМіттал Кривий Ріг",
    category: "industry",
    lat: 47.9,
    lon: 33.42,
    operator: "ArcelorMittal",
    detail: "металургія",
  },
  {
    name: "Запоріжсталь",
    category: "industry",
    lat: 47.88,
    lon: 35.2,
    operator: "Метінвест",
    detail: "металургія",
  },
  {
    name: "Дніпровський МК (Камʼянське)",
    category: "industry",
    lat: 48.51,
    lon: 34.62,
    detail: "металургія",
  },
  {
    name: "Черкаський «Азот»",
    category: "industry",
    lat: 49.47,
    lon: 32.12,
    operator: "OSTCHEM",
    detail: "хімія",
  },
  {
    name: "«Рівнеазот»",
    category: "industry",
    lat: 50.57,
    lon: 26.2,
    operator: "OSTCHEM",
    detail: "хімія",
  },
  {
    name: "Південний ГЗК (Кривий Ріг)",
    category: "industry",
    lat: 47.75,
    lon: 33.3,
    detail: "гірничо-збагачувальний",
  },
  {
    name: "Інтерпайп Сталь (Дніпро)",
    category: "industry",
    lat: 48.42,
    lon: 35.0,
    operator: "Интерпайп",
    detail: "металургія",
  },
];

/**
 * Опорні обʼєкти у форматі Facility.
 *
 * `source` навмисно порожній, а `origin` — `baseline`. Раніше сюди
 * підставлялося посилання `openstreetmap.org/#map=14/lat/lon`: воно відкриває
 * карту в цій точці й через це виглядає як посилання на запис в OSM, хоча
 * жодного запису не називає. Вбитий руками обʼєкт із приблизними координатами
 * ставав у інтерфейсі не відрізнити від перевіреного.
 */
export const SEED_FACILITIES: Facility[] = SEED.map((s, i) => ({
  id: `seed/${s.category}/${i}`,
  name: s.name,
  category: s.category,
  lat: s.lat,
  lon: s.lon,
  ...(s.operator ? { operator: s.operator } : {}),
  ...(s.detail ? { detail: s.detail } : {}),
  source: "",
  origin: "baseline" as const,
}));
