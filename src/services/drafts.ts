import { db } from "../db/index.js";
import { sessions } from "../db/schema.js";
import { eq } from "drizzle-orm";
import type { DraftReview, SessionData } from "../session/types.js";

/**
 * Принудительно сохраняет черновик в основную сессию в БД.
 * Это необходимо для корректной работы сервиса напоминаний, 
 * так как данные внутри conversation могут быть не видны до завершения диалога.
 */
export async function saveDraft(chatId: number, draft: DraftReview | undefined) {
  const key = chatId.toString();
  
  // Читаем текущую сессию
  const [row] = await db.select().from(sessions).where(eq(sessions.key, key)).limit(1);
  const data = (row?.value as SessionData) || {};
  
  const updated: SessionData = { ...data, draft };
  
  // Пишем обратно с обновлением updatedAt
  await db
    .insert(sessions)
    .values({ key, value: updated, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: sessions.key,
      set: { value: updated, updatedAt: new Date() },
    });
}
