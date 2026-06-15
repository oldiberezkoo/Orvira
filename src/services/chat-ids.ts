import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { chatIds } from "../db/schema.js";

/**
 * Сохраняет chat_id в таблицу chat_ids (все чаты, которые когда-либо запускали бота).
 * При повторном /start обновляет lastSeenAt.
 * @returns true, если это первый запуск /start в этом чате
 */
export async function recordChatId(chatId: number): Promise<boolean> {
  const existing = await db.select().from(chatIds).where(eq(chatIds.chatId, chatId)).limit(1);
  const isFirstStart = existing.length === 0;
  const now = new Date();
  await db
    .insert(chatIds)
    .values({
      chatId,
      firstSeenAt: now,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: chatIds.chatId,
      set: { lastSeenAt: now },
    });
  return isFirstStart;
}
