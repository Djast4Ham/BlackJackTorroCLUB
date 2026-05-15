# Финальная проверка проекта

Дата проверки: 2026-05-14

## Статус

Проект подготовлен к загрузке на GitHub и деплою на Render.

## Сохранённые требования

- VK Mini App ID: `54584981`
- VK ID администратора: `1057236881`
- Визуальный стиль, фон, главное меню, барный столик и чат не изменялись по композиции.
- Тяжёлый 3D-стол не возвращался.
- Внутриигровая валюта начисляется админом на реальные VK ID через сервер.

## Что изменено в финальном проходе

- Проект подготовлен под GitHub без бинарного фона: исходный JPEG встроен в `public/assets/splash.svg`, визуально фон остаётся тем же.
- Добавлен `render.yaml` для Render Blueprint.
- Добавлены `.node-version` и `.nvmrc`.
- В `package.json` добавлен `engines.node >=22.16.0 <25.0.0`.
- Добавлена команда `npm run check`.
- `.env.example` очищен от placeholder-секретов.
- `.gitignore` усилен: база SQLite, `.env`, runtime JSON и логи не попадут в Git.
- Runtime-хранилище остаётся SQLite, для Render настроен путь `/var/data/bar.sqlite`.

## Проверки

```text
npm ci — успешно
node --check server/index.js — успешно
node --check server/db.js — успешно
node --check server/vk-sign-check.js — успешно
npm run build — успешно
npm audit --audit-level=low — 0 vulnerabilities
GET /api/health — успешно
```

## Текущая архитектура

- Frontend: React + Vite
- Realtime: Socket.IO
- Backend: Express
- Security: Helmet, CORS allow-list, API rate limits, Socket.IO rate limits, VK launch signature validation
- Storage: SQLite through `node:sqlite`
- Future DB path: `server/postgres-schema.sql`

## Production-ограничения

В production сервер намеренно блокирует Socket.IO без `VK_CLIENT_SECRET`. Это нужно, чтобы нельзя было подделать VK ID администратора или пользователя через URL/клиент.

## Следующие задачи

1. Подключить реальные VK платежи и серверное подтверждение покупки.
2. Добавить модерацию: мут, бан, удаление сообщений.
3. Добавить таблицу пользователей и роли администраторов.
4. Добавить резервное копирование базы.
5. При росте нагрузки перейти с SQLite на PostgreSQL.
