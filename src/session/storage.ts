import type { StorageAdapter } from "grammy";
import { db } from "../db/index.js";
import { sessions } from "../db/schema.js";
import { eq } from "drizzle-orm";

/** Сессии хранятся в БД бессрочно (без TTL). */
function createDbStorage(): StorageAdapter<unknown> {
  return {
    read: async (key: string) => {
      const [row] = await db.select().from(sessions).where(eq(sessions.key, key)).limit(1);
      return (row?.value as unknown) ?? undefined;
    },
    write: async (key: string, value: unknown) => {
      await db
        .insert(sessions)
        .values({ key, value, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: sessions.key,
          set: { value, updatedAt: new Date() },
        });
    },
    delete: async (key: string) => {
      await db.delete(sessions).where(eq(sessions.key, key));
    },
  };
}

const memory = new Map<string, unknown>();

function createMemoryStorage(): StorageAdapter<unknown> {
  return {
    read: async (key: string) => memory.get(key) as unknown,
    write: async (key: string, value: unknown) => {
      memory.set(key, value);
    },
    delete: async (key: string) => {
      memory.delete(key);
    },
  };
}

export function createSessionStorage(): StorageAdapter<unknown> {
  try {
    return createDbStorage();
  } catch {
    return createMemoryStorage();
  }
}
