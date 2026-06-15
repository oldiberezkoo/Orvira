# AGENTS.md — rsxr

Telegram bot for collecting customer reviews (Myata & Gao restaurants). Built with Bun + Grammy + Drizzle ORM (PostgreSQL) + Zod.

## Commands

| Script | Purpose |
|---|---|
| `bun run dev` | Watch mode (`bun run --watch src/index.ts`) |
| `bun run start` | Production |
| `bun db:generate` | Generate SQL migration |
| `bun db:migrate` | Apply migrations |
| `bun db:push` | Push schema directly (dev) |
| `bun db:studio` | Drizzle Studio UI |
| `bun tsc --noEmit` | Type check — run after every code change |
| `bun test` | Run tests (bun:test, none exist yet) |

## Imports & TypeScript

- **ESM only**. Relative imports **must** include `.js` extension:
  `import { foo } from "../bar.js"` ✅
- No path aliases, use relative paths.
- `"strict": true` in tsconfig. No `any`, no `@ts-ignore`.
- Drizzle types: `typeof reviews.$inferSelect` / `typeof reviews.$inferInsert`.
- No formatter/linter config — match existing style manually.

## Architecture

### Entrypoint

`src/index.ts` → creates bot, starts background intervals.

### Bot handlers

Register all handlers in `src/bot/index.ts`.
- `bot.command()` for slash commands
- `bot.callbackQuery()` with regex for dynamic callback data
- Review **conversation** (`@grammyjs/conversations`) in `src/handlers/review-flow.ts`
- Review **editing** uses plain callback query handlers in `src/handlers/edit-review.ts` (not conversations)

### Session storage

PostgreSQL `sessions` table (adapter in `src/session/storage.ts`). Falls back to in-memory Map if DB unavailable. No TTL.

### Background services (src/index.ts)

- `processSyncQueue` — retries failed Sheets/Drive sync every **60s**
- `processDraftReminders` — nags users with incomplete drafts every **10s**

### Google integrations

- **Auth**: Service account JSON from `GOOGLE_APPLICATION_CREDENTIALS` path or `GOOGLE_CREDENTIALS_BASE64` env var (`src/services/google-auth.ts`)
- **Sheets**: `SHEETS_SPREADSHEET_ID` + `SHEETS_SHEET_NAME` env vars
- **Photos**: GCS (Google Cloud Storage) via `src/services/gcs.ts`. `drive.ts` just re-exports from `gcs.ts`. A `sync_queue` table tracks failures.

### DB schema (`src/db/schema.ts`)

Tables: `users`, `reviews`, `sync_queue`, `sessions`, `chat_ids`.

### Branch/department config (`src/lib/branches.ts`)

5 branches (`myata_lounge`, `myata_signature_tashcity`, `myata_signature_sky`, `gaogao`, `gao_coffee_tea`). Departments vary per branch — `gao_coffee_tea` has only `bar` + `service`.

### Tags (`src/lib/tags.ts`)

9 predefined problem tags with emoji labels.

### Validation (`src/lib/validation.ts`)

Zod schemas for all user inputs. Max 10 photos (`PHOTO_MAX_COUNT`).

## Conventions

- Files: `kebab-case.ts`
- Tables/columns: `snake_case` in SQL
- Variables/functions: `camelCase`
- UI language: Russian
- `createId()` uses `uuidv7` (`src/lib/uuid.ts`)
- Never commit `.env` or `service-account.json`
