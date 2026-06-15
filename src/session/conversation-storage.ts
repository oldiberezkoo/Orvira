import type { Context } from "../bot/context.js";
import { db } from "../db/index.js";
import { sessions } from "../db/schema.js";
import { eq } from "drizzle-orm";

const CONV_PREFIX = "conv:";

/** Хранилище состояний конверсаций в БД (то же, что и сессии — бессрочно). Ключ = prefix + chatId, плагин передаёт его в adapter как есть. */
function createConversationStorage() {
  const adapter = {
    read: async (key: string) => {
      const [row] = await db.select().from(sessions).where(eq(sessions.key, key)).limit(1);
      return (row?.value as unknown) ?? undefined;
    },
    write: async (key: string, state: unknown) => {
      await db
        .insert(sessions)
        .values({ key, value: state, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: sessions.key,
          set: { value: state, updatedAt: new Date() },
        });
    },
    delete: async (key: string) => {
      await db.delete(sessions).where(eq(sessions.key, key));
    },
  };

  return {
    type: "key" as const,
    version: 1,
    getStorageKey: (ctx: Context) => ctx.chat?.id?.toString(),
    prefix: CONV_PREFIX,
    adapter,
  };
}

export const conversationStorage = createConversationStorage();
