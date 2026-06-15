import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { eq } from "drizzle-orm";

export async function getOrCreateUser(
  telegramUserId: number,
  fullName: string
): Promise<{ fullName: string }> {
  const [existing] = await db.select().from(users).where(eq(users.telegramUserId, telegramUserId)).limit(1);
  if (existing) {
    return { fullName: existing.fullName };
  }
  await db.insert(users).values({
    telegramUserId,
    fullName,
  });
  return { fullName };
}

export async function getUserName(telegramUserId: number): Promise<string | null> {
  const [row] = await db.select().from(users).where(eq(users.telegramUserId, telegramUserId)).limit(1);
  return row?.fullName ?? null;
}

export async function updateUserName(telegramUserId: number, fullName: string): Promise<void> {
  const [existing] = await db.select().from(users).where(eq(users.telegramUserId, telegramUserId)).limit(1);
  if (existing) {
    await db.update(users).set({ fullName, updatedAt: new Date() }).where(eq(users.telegramUserId, telegramUserId));
  } else {
    await db.insert(users).values({ telegramUserId, fullName });
  }
}
