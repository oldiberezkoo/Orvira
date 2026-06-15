import { desc, gte, sql } from "drizzle-orm";
import { InlineKeyboard } from "grammy";
import type { Context } from "../bot/context.js";
import { isAdmin } from "../config.js";
import { db } from "../db/index.js";
import type { BranchId, ReviewRow } from "../db/schema.js";
import { BRANCHES, reviews } from "../db/schema.js";
import { BRANCH_CONFIG } from "../lib/branches.js";
import { formatTags } from "../lib/tags.js";
import { getDriveFolderLink, getSheetsLink } from "../services/sheets.js";

function requireAdmin(ctx: Context): boolean {
  const id = ctx.from?.id;
  if (!id || !isAdmin(id)) {
    return false;
  }
  return true;
}

export const ADMIN_MENU_KEYBOARD = new InlineKeyboard([
  [{ text: "📋 Экспорт (таблица + Drive)", callback_data: "admin:export" }],
  [{ text: "📄 Последние 5 отзывов", callback_data: "admin:last" }],
  [{ text: "🏢 Филиалы", callback_data: "admin:branches" }],
  [{ text: "◀️ В меню", callback_data: "menu:back" }],
]);

const ADMIN_BACK_KEYBOARD = new InlineKeyboard([
  [{ text: "В меню", callback_data: "menu:admin" }],
]);

export async function handleAdminMenu(ctx: Context): Promise<void> {
  if (!requireAdmin(ctx)) {
    await ctx.reply("Доступ только для администраторов.");
    return;
  }
  await ctx.reply("Команды админа:", { reply_markup: ADMIN_MENU_KEYBOARD });
}

export async function handleAdminExport(ctx: Context): Promise<void> {
  if (!requireAdmin(ctx)) {
    await ctx.reply("Доступ только для администраторов.");
    return;
  }
  const sheetsLink = getSheetsLink();
  const driveLink = getDriveFolderLink();
  const parts: string[] = [];
  if (sheetsLink) parts.push(`📋 Таблица отзывов:\n${sheetsLink}`);
  if (driveLink) parts.push(`📁 Google Drive (фото):\n${driveLink}`);
  if (parts.length === 0) {
    await ctx.reply("Google Sheets и Drive не настроены.", {
      reply_markup: ADMIN_BACK_KEYBOARD,
    });
    return;
  }
  await ctx.reply(parts.join("\n\n"), { reply_markup: ADMIN_BACK_KEYBOARD });
}

/** Форматирует один отзыв в виде полной карточки (как уведомление админу). */
function formatReviewCard(row: ReviewRow, sheetsLink: string | null): string {
  const branch = row.branch as BranchId;
  const branchLabel = BRANCH_CONFIG[branch].label;
  const depts = BRANCH_CONFIG[branch].departments;
  const kitchenLine = depts.includes("kitchen")
    ? `Кухня: ${row.ratingKitchen ?? "—"}/5`
    : "";
  const barLine = `Бар: ${row.ratingBar}/5`;
  const hookahLine = depts.includes("hookah")
    ? `Кальян: ${row.ratingHookah ?? "—"}/5`
    : "";
  const serviceLine = `Сервис: ${row.ratingService}/5`;
  const commentPreview =
    row.comment.length > 200 ? row.comment.slice(0, 200) + "…" : row.comment;
  const driveLink = row.driveFolderId
    ? `https://drive.google.com/drive/folders/${row.driveFolderId}`
    : "—";
  const photoCount =
    ((row.driveLinks as string[]) ?? []).length ||
    ((row.photoFileIds as string[]) ?? []).length;
  return [
    "🆕 Отзыв",
    "",
    `👤 Имя: ${row.guestName}${
      row.telegramUsername ? ` (@${row.telegramUsername})` : ""
    }`,
    `🏢 Филиал: ${branchLabel}`,
    `📅 Визит: ${row.visitDate.toLocaleDateString("ru-RU")}`,
    `🍽️ Блюдо: ${row.dishName}`,
    "",
    "⭐️ Рейтинги:",
    kitchenLine,
    barLine,
    hookahLine,
    serviceLine,
    `📊 Общий: ${row.ratingOverall}/5`,
    "",
    `🏷️ Теги: ${(row.tags ?? []).length ? formatTags(row.tags ?? []) : "—"}`,
    "",
    `💬 ${commentPreview}`,
    "",
    `📷 Фото: ${photoCount} шт.`,
    sheetsLink ? `📋 Таблица: ${sheetsLink}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function handleAdminLast(
  ctx: Context,
  optLimit?: number
): Promise<void> {
  if (!requireAdmin(ctx)) {
    await ctx.reply("Доступ только для администраторов.");
    return;
  }
  let n = optLimit ?? 10;
  const match = ctx.message?.text?.match(/\/last\s*(\d+)?/);
  if (match) n = Math.min(parseInt(match[1] ?? "10", 10) || 10, 50);
  const list = await db
    .select()
    .from(reviews)
    .orderBy(desc(reviews.createdAt))
    .limit(n);
  if (list.length === 0) {
    await ctx.reply("Нет отзывов.", { reply_markup: ADMIN_BACK_KEYBOARD });
    return;
  }
  const sheetsLink = getSheetsLink();
  const cards = list.map((r) => formatReviewCard(r, sheetsLink));
  const block = cards.join("\n\n———\n\n");
  await ctx.reply("Последние отзывы:\n\n" + block, {
    reply_markup: ADMIN_BACK_KEYBOARD,
  });
}

const DEPARTMENT_NAMES: Record<string, string> = {
  kitchen: "Кухня",
  bar: "Бар",
  hookah: "Кальян",
  service: "Сервис",
};

export async function handleAdminBranches(ctx: Context): Promise<void> {
  if (!requireAdmin(ctx)) {
    await ctx.reply("Доступ только для администраторов.");
    return;
  }
  const lines = BRANCHES.map((b) => {
    const cfg = BRANCH_CONFIG[b];
    const label = cfg.label;
    const depts = (cfg.departments as string[])
      .map((d) => DEPARTMENT_NAMES[d] ?? d)
      .join(", ");
    return `• ${label}\n  Параметры: ${depts}`;
  });
  await ctx.reply(
    "Филиалы:\n\n" +
      lines.join("\n\n") +
      "\n\nУправление списком филиалов — в коде (schema.ts, branches).",
    { reply_markup: ADMIN_BACK_KEYBOARD }
  );
}

export async function handleAdminStats(ctx: Context): Promise<void> {
  // /stats — статистика за месяц (оставляем для обратной совместимости)
  if (!requireAdmin(ctx)) {
    await ctx.reply("Доступ только для администраторов.");
    return;
  }
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const rows = await db
    .select({
      branch: reviews.branch,
      count: sql<number>`count(*)::int`,
      avgRating: sql<number>`round(avg(${reviews.ratingOverall})::numeric, 2)`,
    })
    .from(reviews)
    .where(gte(reviews.createdAt, monthStart))
    .groupBy(reviews.branch);
  const lines = rows.map((r) => {
    const label = BRANCH_CONFIG[r.branch as keyof typeof BRANCH_CONFIG].label;
    return `${label}: ${r.count} отзывов, ср. ${r.avgRating}`;
  });
  await ctx.reply(
    `Статистика за текущий месяц:\n\n${lines.join("\n") || "Нет данных"}`
  );
}
