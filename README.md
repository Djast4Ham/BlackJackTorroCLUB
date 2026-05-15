# БАР Знакомств! — VK Mini App

VK Mini App для проекта **Бутылочка!**: заставка, главное меню, магазин валюты, отдельная комната бара, лёгкий CSS-барный столик-рамка, бутылка по клику, общий чат, SQLite-хранилище и защищённая админ-панель.

## Зафиксированные параметры проекта

- VK Mini App ID: `54584981`
- VK ID администратора: `1057236881`
- Админ может начислять внутриигровую валюту реальным VK ID пользователей.
- Визуальный стиль, фон, главное меню, барный столик и чат сохранены.

## Что уже сделано

- Начальная заставка на базе исходного фона. Для GitHub фон хранится как текстовый `public/assets/splash.svg` с тем же JPEG внутри, поэтому бинарный `splash.jpg` не нужен.
- Главное меню: `Главная`, `Магазин`, `БАР Знакомств!`.
- Магазин с валютой BJT и звёздами.
- Курсы:
  - `10 BJT = 1 голос VK = 7 ₽`
  - `10 BJT = 20 звёздам`
- Отдельная комната бара:
  - тяжёлый `table.glb` вырезан;
  - вместо него используется лёгкая CSS-рамка барного столика без WebGL и внешней модели;
  - 12 фиксированных стульев по кругу;
  - имена участников отображаются над местами;
  - бутылка крутится по клику;
  - справа большой чат с именем, датой и временем.
- VK Bridge: приложение пробует получить реальный профиль пользователя через `VKWebAppGetUserInfo`.
- Серверная проверка VK launch-подписи.
- Админ-режим для VK ID `1057236881`: панель начисления BJT/звёзд тестерам.
- Socket.IO сервер для общего чата, балансов и списка участников.
- SQLite-хранилище `data/bar.sqlite` вместо JSON.
- Отдельный журнал валютных транзакций `currency_transactions`.
- Защита от повторного начисления через `request_id`.
- Автоматическая миграция из старого `data/bar.json`, если база ещё пустая.
- Защита: Helmet, CORS allow-list, rate-limit API, rate-limit Socket.IO, запрет админ-действий без доверенной VK-подписи в production.
- Подготовлен `render.yaml` для Render.

## Важно по безопасности

`VK_SERVICE_KEY` и `VK_CLIENT_SECRET` нельзя хранить во фронтенде. Не вставляйте их в `src/`, `public/` и не коммитьте в Git.

Создайте `.env` на сервере по примеру:

```bash
cp .env.example .env
```

В production обязательно заполните `VK_CLIENT_SECRET`. Без него production-сервер не будет принимать Socket.IO-подключения, потому что VK ID нельзя безопасно подтвердить.

## SQLite / PostgreSQL

Сейчас runtime использует SQLite без нативных npm-зависимостей через `node:sqlite`.

Для PostgreSQL добавлен черновой production-schema файл:

```text
server/postgres-schema.sql
```

Полноценный PostgreSQL-драйвер можно подключить следующим этапом через async DB-адаптер.

По умолчанию база создаётся здесь:

```text
data/bar.sqlite
```

Для Render с persistent disk используется:

```env
SQLITE_PATH=/var/data/bar.sqlite
```

Настройки:

```env
SQLITE_PATH=./data/bar.sqlite
MAX_STORED_MESSAGES=5000
MAX_ADMIN_LOGS=5000
MAX_TRANSACTIONS=20000
ADMIN_INITIAL_BJT=1000
DEFAULT_INITIAL_BJT=50
VK_SIGN_MAX_AGE_SECONDS=172800
```

Старый файл `data/bar.json`, если он есть, переносится в SQLite один раз при первом запуске, когда таблицы ещё пустые.

## Запуск локально

Требуется Node.js `22.16.0+`, но ниже Node 25. Версия закреплена в `.node-version`, `.nvmrc` и `package.json`.

```bash
npm ci
npm run server
```

Во втором терминале:

```bash
npm run dev
```

Откройте:

```text
http://localhost:5173
```

Для проверки демо-режима вне VK можно открыть:

```text
http://localhost:5173/?vk_user_id=1057236881
```

Важно: это только dev-режим. В production админ-права выдаются только при валидной VK-подписи.

## Проверка перед деплоем

```bash
npm ci
npm run check
npm audit --audit-level=low
```

`npm run check` выполняет:

- `node --check server/index.js`
- `node --check server/db.js`
- `node --check server/vk-sign-check.js`
- `npm run build`

## Сборка для публикации

```bash
npm run build
npm start
```

Сервер будет отдавать собранный фронтенд из папки `dist`.

## Render

В репозитории есть `render.yaml`.

Основные настройки:

- Runtime: `node`
- Region: `frankfurt`
- Build command: `npm ci && npm run build`
- Start command: `npm start`
- Health check path: `/api/health`
- Persistent disk: `/var/data`
- SQLite path: `/var/data/bar.sqlite`

После создания сервиса в Render нужно заполнить секреты:

```env
VK_CLIENT_SECRET=...
VK_SERVICE_KEY=...
CLIENT_URL=https://ВАШ-СЕРВИС.onrender.com
```

После деплоя этот HTTPS-адрес нужно указать в настройках VK Mini App `54584981`.

## Что подключить следующим шагом

1. Реальные VK платежи/голоса и выдачу BJT только после серверного подтверждения платежа.
2. Бан-лист, мут, удаление сообщений и журнал модерации.
3. Отдельную таблицу пользователей и роли администраторов в БД.
4. Резервное копирование SQLite/PostgreSQL.
5. Полноценный PostgreSQL-адаптер, если проект выйдет за рамки SQLite.


## Render npm ci error fix

If Render shows `npm error Run "npm help ci" for more info`, it usually means Render cannot see `package-lock.json` in the repository root. This version uses `npm install && npm run build` in `render.yaml` so the build also works when the lockfile was not uploaded. Keep `package-lock.json` committed when possible.
