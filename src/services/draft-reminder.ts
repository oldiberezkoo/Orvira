import { and, eq, lt, sql, or } from "drizzle-orm";
import { bot } from "../bot/index.js";
import { db } from "../db/index.js";
import { sessions } from "../db/schema.js";
import type { SessionData } from "../session/types.js";

/**
 * Интервалы между напоминаниями (в минутах).
 */
const REMINDER_CONFIG = [
  { level: 1, waitMinutes: 1 },
  { level: 2, waitMinutes: 1 },
  { level: 3, waitMinutes: 1 },
];

/**
 * Находит пользователей, которые либо имеют черновик в основной сессии,
 * либо находятся в активной конверсации 'review'.
 */
export async function processDraftReminders(): Promise<void> {
  const minWait = 1;
  const baseCutoff = new Date(Date.now() - 30 * 1000);

  const rows = await db
    .select()
    .from(sessions)
    .where(
      and(
        or(
          sql`(${sessions.value}->'draft') IS NOT NULL`,
          and(
            sql`${sessions.key} LIKE 'conv:%'`,
            sql`(${sessions.value}->'state'->'review') IS NOT NULL`
          )
        ),
        lt(sessions.updatedAt, baseCutoff)
      )
    );

  for (const row of rows) {
    const isConv = row.key.startsWith("conv:");
    const chatIdStr = isConv ? row.key.slice(5) : row.key;
    const chatId = parseInt(chatIdStr, 10);
    if (Number.isNaN(chatId)) continue;

    const sessionKey = chatIdStr;
    const [mainRow] = await db.select().from(sessions).where(eq(sessions.key, sessionKey)).limit(1);
    
    let mainData = (mainRow?.value as SessionData) || {};
    if (!mainData.draft || Object.keys(mainData.draft).length === 0) {
        // Если черновика нет, значит отзыв завершён или отменён.
        // Не создаём пустой объект, чтобы не запускать цикл напоминаний заново.
        continue;
    }

    const currentLevel = mainData.draft.reminderLevel ?? 0;
    const nextConfig = REMINDER_CONFIG.find((c) => c.level === currentLevel + 1);
    
    if (!nextConfig) continue;

    // ВАЖНО: берем максимальное время обновления между конверсацией и основной сессией.
    // Это не дает отправлять напоминания слишком часто, если одно из них только что ушло.
    const convRow = isConv ? row : null;
    const mainUpdateAt = mainRow?.updatedAt?.getTime() ?? 0;
    const convUpdateAt = convRow?.updatedAt?.getTime() ?? 0;
    const lastUpdateMs = Math.max(mainUpdateAt, convUpdateAt);
    
    const diffMs = Date.now() - lastUpdateMs;
    const diffMin = (diffMs + 5000) / (60 * 1000);

    if (diffMin >= nextConfig.waitMinutes) {
      try {
        // Удаляем предыдущее сообщение напоминания, если оно есть
        if (mainData.draft.lastReminderMessageId) {
          try {
            await bot.api.deleteMessage(chatId, mainData.draft.lastReminderMessageId);
          } catch (deleteErr) {
            // Игнорируем ошибки удаления (например, если пользователь уже удалил сообщение)
          }
        }

        const sentMsg = await bot.api.sendMessage(
          chatId,
          "🍃 ~ Мы очень ждём вашего отзыва! Пожалуйста, допишите его. ",
        );

        mainData.draft.reminderLevel = nextConfig.level;
        mainData.draft.lastReminderMessageId = sentMsg.message_id;

        await db
          .insert(sessions)
          .values({ key: sessionKey, value: mainData, updatedAt: new Date() })
          .onConflictDoUpdate({
            target: sessions.key,
            set: { value: mainData, updatedAt: new Date() },
          });

      } catch (err: any) {
        if (
          err?.description?.includes("forbidden") ||
          err?.description?.includes("blocked")
        ) {
          await db.delete(sessions).where(eq(sessions.key, `conv:${chatIdStr}`));
          const updated = { ...mainData, draft: undefined };
          await db.update(sessions).set({ value: updated }).where(eq(sessions.key, sessionKey));
        } else {
          console.error(`Draft reminder send error to ${chatId}:`, err);
        }
      }
    }
  }
}
