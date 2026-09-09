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

### Тести

Тести написані під вбудований рушій Bun (`import { ... } from "bun:test"`),
тому запускаються **тільки** через Bun. `vitest` на них падає з
`Cannot find package 'bun:test'` — це не поламані тести, а не той рушій.

```sh
bun test        # усі тести фронтенду (те саме, що bun run test)
bunx tsgo --noEmit   # перевірка типів
bun run lint
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
