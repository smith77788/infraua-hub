# InfraUA Hub

Давай создадим сайт для моего проекта InfraUA. Подключился к репозиторий проекта сначала

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/31c50c3c-d898-4f10-98e5-890681b6110e).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```

## Звʼязок із платформою Palanter

Консоль може передати свою картину — обʼєкти, події та звʼязки живлення разом
із їх походженням — у платформу Palanter, де вони підпадають під онтологію,
рівні доступу і журнал аудиту. Похідні оцінки (критичність, наслідки відмов)
не передаються навмисно: у платформі вони перераховуються з графа.

Дві змінні середовища **на сервері** вмикають кнопку «Передати картину»:

```
PALANTER_API_URL=https://<ваш-palanter>.up.railway.app
PALANTER_API_KEY=<ключ із PLATFORM_API_KEYS>
```

Ключ читається лише в серверній функції й у клієнтський бандл не потрапляє.
Без цих змінних консоль працює як раніше — кнопки просто немає, це штатний
стан, а не помилка.

На боці Palanter потрібно дозволити походження консолі в `CORS_ORIGINS`.

## Перевірка

```
bun install
npm run typecheck   # tsc --noEmit
npm run lint        # eslint + prettier
npm test            # bun test src/
npm run build
```

Тести написані під вбудований рушій Bun (`import { describe, expect, it } from "bun:test"`),
бо цим самим Bun проєкт і збирається. `vitest` у залежностях немає — запуск його
ззовні впаде на всіх файлах, і це не поламані тести, а не той рушій. Спосіб
запуску один: `npm test`.

Тими самими чотирма командами і в тому самому порядку йде CI
(`.github/workflows/ci.yml`), тож локальний прогін означає те саме, що й
перевірка на сервері.

## Розгортання на Railway

Консоль розгортається у двох місцях одночасно, і це навмисно: Lovable збирає
її під Cloudflare Workers, Railway — під Node. Другий шлях потрібен, бо на
ньому буде Telegram Mini App, якому потрібен стабільний власний домен.

Різницю робить одна змінна середовища **на боці Railway**:

```
NITRO_PRESET=node-server
```

Без неї збірка йде під Cloudflare (це типова ціль пресету
`@lovable.dev/vite-tanstack-config`), контейнер не слухає `PORT`, і Railway
віддає 502 при цілком успішній збірці. Саме так це й виглядало спочатку:
статус деплою `SUCCESS`, а сторінка недоступна.

Усередині власного середовища Lovable ця змінна ігнорується — пресет її
навмисно вичищає, — тож увімкнути її на Railway безпечно: збірку для Lovable
вона не зачіпає.

Запуск на Railway: `npm start` (`node .output/server/index.mjs`). Порт бере з
`PORT`, який Railway задає сам.

## Платформа (`platform/`)

Аналітична платформа — онтологія, граф знань із рівнями доступу, ланцюжок
аудиту, пісочниця для обчислень, слідчий агент. Раніше вона жила в окремому
репозиторії `Palanter`; тепер це один продукт і один репозиторій, а `platform/`
— її місце тут.

```
npm run platform:typecheck   # tsc -p platform/tsconfig.json
npm run platform:test        # bun test platform/tests  (203 тести)
npm run platform:build       # компіляція + межа CommonJS
npm run platform:start       # node platform/dist/api/server.js
```

`npm run check` виконує і консоль, і платформу — тими самими кроками, що й CI.

**Чому окремий tsconfig.** Консоль — це ESM зі строгими правилами під браузер;
платформа — CommonJS під Node. Одні налаштування на двох означали б послабити
консоль до рівня, який влаштовує сервер.

**Чому крок збірки, а не просто `tsc`.** У корені оголошено `"type": "module"`
— цього вимагає консоль. Node дивиться на найближчий package.json, тож
скомпільований CommonJS вантажився б як ESM і падав на першому `exports.`.
`platform/build.mjs` кладе у `platform/dist` вкладений package.json із
`"type": "commonjs"` — межа двох модульних систем проходить по каталогу.

Тести платформи не потребують jest: у них немає жодного виклику `jest.*`, тож
вони працюють під вбудованим рушієм Bun, як і решта репозиторію.

Змінні середовища: `PLATFORM_API_KEYS` (JSON-мапа ключ → рівень доступу),
`CORS_ORIGINS`, `PLATFORM_DATA_DIR`, необовʼязково `ANTHROPIC_API_KEY`.
