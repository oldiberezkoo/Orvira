import {
  pgTable,
  uuid,
  bigint,
  varchar,
  text,
  timestamp,
  jsonb,
  integer,
  smallint,
} from "drizzle-orm/pg-core";

export const BRANCHES = [
  "myata_lounge",
  "myata_signature_tashcity",
  "myata_signature_sky",
  "gaogao",
  "gao_coffee_tea",
] as const;
export type BranchId = (typeof BRANCHES)[number];

export const reviewStatuses = ["draft", "confirmed", "edited"] as const;
export type ReviewStatus = (typeof reviewStatuses)[number];

export const users = pgTable("users", {
  telegramUserId: bigint("telegram_user_id", { mode: "number" }).primaryKey(),
  fullName: varchar("full_name", { length: 255 }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type UserRow = typeof users.$inferSelect;
export type UserInsert = typeof users.$inferInsert;

export const reviews = pgTable("reviews", {
  id: uuid("id").primaryKey(),
  telegramUserId: bigint("telegram_user_id", { mode: "number" }).notNull(),
  telegramUsername: varchar("telegram_username", { length: 255 }),
  guestName: varchar("guest_name", { length: 255 }).notNull(),
  visitDate: timestamp("visit_date", { withTimezone: true }).notNull(),
  branch: varchar("branch", { length: 64 }).notNull(),
  dishName: varchar("dish_name", { length: 255 }).notNull(),
  comment: text("comment").notNull(),
  ratingKitchen: smallint("rating_kitchen"),
  ratingBar: smallint("rating_bar").notNull(),
  ratingHookah: smallint("rating_hookah"),
  ratingService: smallint("rating_service").notNull(),
  ratingOverall: smallint("rating_overall").notNull(),
  tags: jsonb("tags").$type<string[]>().default([]).notNull(),
  photoFileIds: jsonb("photo_file_ids").$type<string[]>().default([]).notNull(),
  driveLinks: jsonb("drive_links").$type<string[]>().default([]).notNull(),
  driveFolderId: varchar("drive_folder_id", { length: 512 }),
  sheetsRowId: integer("sheets_row_id"),
  status: varchar("status", { length: 20 }).notNull().default("confirmed"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ReviewRow = typeof reviews.$inferSelect;
export type ReviewInsert = typeof reviews.$inferInsert;

/** Очередь на синхронизацию при недоступности Sheets/Drive */
export const syncQueue = pgTable("sync_queue", {
  id: uuid("id").primaryKey(),
  reviewId: uuid("review_id")
    .notNull()
    .references(() => reviews.id, { onDelete: "cascade" }),
  kind: varchar("kind", { length: 32 }).notNull(), // 'sheets' | 'drive'
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SyncQueueRow = typeof syncQueue.$inferSelect;
export type SyncQueueInsert = typeof syncQueue.$inferInsert;

/** Сессии (бессрочное хранение в БД вместо Redis). Ключ — идентификатор чата/пользователя от grammY. */
export const sessions = pgTable("sessions", {
  key: varchar("key", { length: 256 }).primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SessionRow = typeof sessions.$inferSelect;
export type SessionInsert = typeof sessions.$inferInsert;

/** Все chat_id, которые когда-либо запускали бота (/start). */
export const chatIds = pgTable("chat_ids", {
  chatId: bigint("chat_id", { mode: "number" }).primaryKey(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ChatIdRow = typeof chatIds.$inferSelect;
export type ChatIdInsert = typeof chatIds.$inferInsert;
