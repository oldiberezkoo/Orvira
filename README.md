# Orvira — Telegram Bot for Customer Feedback

> **Проект выведен из эксплуатации.** Написан в январе 2026 года.

Собирает структурированные отзывы посетителей ресторанов. Пользователь проходит пошаговый опрос (conversation), выбирает филиал, оценивает цеха, добавляет теги и фото. Отзывы синхронизируются с Google Sheets, фото загружаются в GCS.

## Tech Stack

- **Runtime:** Bun
- **Bot Framework:** grammY
- **Database:** PostgreSQL (Neon) + Drizzle ORM
- **Session Storage:** PostgreSQL (in-memory Map как fallback)
- **Google APIs:** Sheets API, Cloud Storage (GCS)
- **Validation:** Zod

## Quick Start

```bash
bun install
cp env.example .env  # заполнить переменные
bun run db:migrate
bun run dev
```

## Review Flow

Опрос построен на `@grammyjs/conversations` — состояние хранится в сессии.

1. **Главное меню** — кнопка «✅ Оставить отзыв»
2. **Выбор филиала** — список из `BRANCH_CONFIG` (забит в коде)
3. **Имя** — ввод текстом
4. **Дата визита** — ввод в формате `ДД.ММ.ГГГГ`
5. **Блюдо** — название блюда
6. **Оценки цехов** — для каждого цеха филиала от 1 до 5 (кнопки). Кальян — опционально, кнопка «Пропустить»
7. **Комментарий по каждому цеху** — текстовое поле (опционально, можно пропустить)
8. **Общий комментарий** — текстовое поле
9. **Теги проблем** — выбор из предопределённого списка (9 штук, пагинация по 3 на страницу)
10. **Фото** — до 10 штук, загружаются в GCS под UUID-папку
11. **Подтверждение** — сводка, кнопка «Подтвердить» / «Начать заново»

На каждом шаге можно нажать «Отменить» — черновик сбрасывается.

## Branches & Departments

5 филиалов, у каждого свой набор цехов:

| ID                         | Метка                        | Цеха                          |
| -------------------------- | ---------------------------- | ----------------------------- |
| `myata_lounge`             | Myata Lounge                 | kitchen, bar, hookah, service |
| `myata_signature_tashcity` | Myata Signature TashkentCity | kitchen, bar, hookah, service |
| `myata_signature_sky`      | Myata Signature Sky          | kitchen, bar, hookah, service |
| `gaogao`                   | GaoGao                       | kitchen, bar, service, hookah |
| `gao_coffee_tea`           | Gao Coffe&Tea                | bar, service                  |

Цеха: `Кухня`, `Бар`, `Кальян`, `Сервис`.

## Tags

9 предопределённых тегов с эмодзи. Используются для маркировки типа проблемы:

`Пересолено`, `Горячее/холодное`, `Долгое ожидание`, `Подача`, `Температура напитка`, `Кальян`, `Пресно`, `Качество продукта`.

## Photo Upload

Фото сохраняются в Google Cloud Storage. URL подписываются (signed URL) для доступа по ссылке. Если GCS не настроен, фото не загружаются, отзыв создаётся без них. Ошибки GCS попадают в `sync_queue` и ретраятся раз в минуту.

## Google Sheets Sync

При подтверждении отзыва данные пишутся в Google Sheets. Структура колонок (первые 10):

```
UUID | Дата Визита | Филиал | Блюдо | Кухня | Бар | Кальян | Сервис | Общий | Комментарий (Кухня) | ...
```

Всего 20 колонок (A–T), включая отдельные комментарии по каждому цеху, теги, ссылки на фото, ID пользователя, username, дату создания.

Если Sheets недоступен — запись откладывается в `sync_queue` (таблица в БД), ретрай раз в минуту.

## Session Storage

Сессии grammY хранятся в PostgreSQL (таблица `sessions`). Ключ — chat_id. При недоступности БД падает на in-memory Map. TTL нет (хранятся бессрочно).

## Draft Reminders

Каждые 10 секунд фоновый процесс проверяет незавершённые черновики (есть `draft` в сессии или активная conversation `review`). Если прошло больше минуты с последней активности — отправляется напоминание.

## Admin Commands

- `/admin` — меню админа
- `/export` — ссылка на Google Sheets и GCS
- `/last [N]` — последние N отзывов (по умолчанию 10)
- `/stats` — статистика по филиалам за текущий месяц
- `/all` — экспорт всех отзывов (кратко)

При каждом новом отзыве админы получают уведомление: филиал, дата, рейтинги, теги, текст, количество фото. Если есть фото — отправляются медиа-группой (до 10 штук).

## Review Editing

В разделе «📄 Мои отзывы» пользователь видит свои отзывы (пагинация по 5). В течение 24 часов можно отредактировать отзыв — меняется `status` на `edited`, в Sheets обновляются данные.

## Env Variables

| Variable                         | Required | Description                               |
| -------------------------------- | -------- | ----------------------------------------- |
| `BOT_TOKEN`                      | ✅       | Токен бота от @BotFather                  |
| `DATABASE_URL`                   | ✅       | PostgreSQL (Neon) connection string       |
| `ADMIN_IDS`                      | ✅       | Telegram user ID админов через запятую    |
| `GOOGLE_APPLICATION_CREDENTIALS` |          | Путь к service-account.json               |
| `GOOGLE_CREDENTIALS_BASE64`      |          | Base64 сервисного аккаунта (альтернатива) |
| `SHEETS_SPREADSHEET_ID`          |          | ID Google Sheets таблицы                  |
| `SHEETS_SHEET_NAME`              |          | Имя листа (по умолчанию «Отзывы»)         |
| `GCS_BUCKET`                     |          | Название GCS bucket                       |
| `GCS_PROJECT_ID`                 |          | GCP Project ID                            |
| `DRIVE_SHARED_FOLDER_ID`         |          | Общая папка Drive (загрузка фото)         |

## Structure

```
src/
├── index.ts                        # entrypoint, background intervals
├── config.ts                       # env reader
├── bot/
│   ├── index.ts                    # создание бота, регистрация handlers
│   └── context.ts                  # кастомный Context
├── db/
│   ├── index.ts                    # drizzle client
│   ├── schema.ts                   # tables: users, reviews, sync_queue, sessions, chat_ids
│   └── review-mapper.ts            # row → Review type
├── handlers/
│   ├── start.ts                    # /start, главное меню, мои отзывы
│   ├── admin.ts                    # админские команды
│   ├── review-flow.ts              # conversation — весь процесс сбора отзыва
│   └── edit-review.ts              # редактирование опубликованного отзыва
├── lib/
│   ├── branches.ts                 # конфиг филиалов и цехов
│   ├── tags.ts                     # теги проблем
│   ├── validation.ts               # Zod схемы
│   └── uuid.ts                     # uuidv7
├── services/
│   ├── google-auth.ts              # JWT / сервисный аккаунт
│   ├── gcs.ts                      # загрузка фото в GCS + signed URL
│   ├── drive.ts                    # re-export из gcs (deprecated)
│   ├── sheets.ts                   # Google Sheets API
│   ├── save-review.ts              # сохранение отзыва + sync queue
│   ├── sync-queue.ts               # фоновый ретрай Sheets/GCS
│   ├── draft-reminder.ts           # напоминания о черновиках
│   ├── admin-notify.ts             # уведомление админов
│   ├── users.ts                    # CRUD для users
│   ├── drafts.ts                   # сохранение черновика
│   └── chat-ids.ts                 # отслеживание chat_id
├── session/
│   ├── types.ts                    # типы сессии (SessionData, DraftReview)
│   ├── storage.ts                  # PostgreSQL storage adapter (+ fallback)
│   └── conversation-storage.ts     # отдельный storage для conversations
└── types/
    └── review.ts                   # Review, ReviewRatings, Photos
```

## Error Handling

- **Sheets / GCS offline:** отзыв сохраняется в PostgreSQL, запись в `sync_queue`. Фоновый процесс `processSyncQueue` ретраит раз в минуту.
- **Conversation TTL:** 30 минут неактивности — сессия протухает, пользователь может начать заново.
- **Draft reminder:** если пользователь заблокировал бота — сессия чистится, напоминания прекращаются.
