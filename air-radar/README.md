# Tactical Air Target Radar — Common Operating Picture

Реал-тайм радар повітряних цілей у стилі Palantir Gotham/AIP: три-панельний
COP-інтерфейс + бекенд-конвеєр, що приймає, геокодує та стрімить **реальні**
дані з відкритих OSINT-джерел, які парсять публічні Telegram-канали.

> Без симуляційних даних. Джерела — реальні. Власні алгоритми (гео-нормалізація,
> екстрактор, векторна математика) розроблені всередині проєкту й покриті тестами.

## Архітектура

```
frontend/                COP-клієнт (Leaflet + WebSocket, три панелі, HUD)
backend/
  build_geodb.py         генерація гео-бази з GeoNames (UA populated places)
  geocode.py             нормалізація назв, пошук у тексті, азимут/дистанція
  extractor.py           NLP/RegEx: тип цілі, маршрут, напрямок, впевненість
  pipeline.py            повідомлення → екстракція → геокод → TacticalObject
  models.py              TacticalObject + метадані типів (колір/швидкість)
  broadcaster.py         стан у памʼяті + WebSocket-розсилка дельт
  persistence.py         SQLite-історія треків (памʼять/аналітика/replay)
  bridge_detoyshahed.py  живий OSINT-міст (позиції цілей + полігони тривог)
  ingest_telethon.py     продакшн-інжест сирих Telegram-повідомлень (опційно)
  server.py              FastAPI: /ws, /api/*, статика COP
  tests/                 pytest (гео, екстрактор, конвеєр)
```

### Потоки даних
1. **Bridge (за замовчуванням, без ключів)** — `detoyshahed.in.ua` віддає вже
   розпарсені з Telegram позиції цілей (`/api/incidents/active`) та активні
   зони тривог полігонами (`/api/alerts/active`). Дає живі дані одразу.
2. **Telethon (продакшн, повний NLP)** — прямий слухач публічних каналів;
   кожне сире повідомлення проходить екстрактор → геокодер → вектор-математику.
   Потребує ключів Telegram (**HUMAN ACTION**, див. нижче).

## Запуск

```bash
cd air-radar
./run.sh            # venv + залежності + гео-база + сервер
# → http://localhost:8000
```

Ручний варіант:
```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m backend.build_geodb          # одноразово: будує backend/data/geo.sqlite
uvicorn backend.server:app --port 8000
```

## Тести
```bash
pytest backend/tests -q     # 10 тестів: нормалізація, склонення, азимут, екстракція, конвеєр
```

## HUMAN ACTION — ключі Telegram (для повного NLP-інжесту)
1. Відкрийте <https://my.telegram.org> → **API development tools**.
2. Створіть застосунок, скопіюйте `api_id` та `api_hash`.
3. Впишіть їх у `.env` (`TG_API_ID`, `TG_API_HASH`) і перезапустіть.
   Доти працює bridge — сервіс уже стрімить реальні цілі.

## API
- `GET /api/health` — стан сервісу.
- `GET /api/state` — повний снапшот (обʼєкти, зони, логи).
- `GET /api/stats?window=3600` — статистика треків за вікно.
- `GET /api/track/{id}` — історія позицій обʼєкта.
- `WS /ws` — потік дельт: `snapshot | upsert | remove | zones | log`.

## Джерела
GeoNames (гео-база), detoyshahed.in.ua (реальні OSINT-цілі та зони тривог,
агреговані з публічних Telegram-каналів). Дані OSINT — не офіційні; джерело
підписане в UI та логах.
