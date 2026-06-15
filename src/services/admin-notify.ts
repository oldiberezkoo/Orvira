import { bot } from "../bot/index.js";
import { config, isAdmin } from "../config.js";
import { getSheetsLink } from "./sheets.js";
import { BRANCH_CONFIG } from "../lib/branches.js";
import { formatTags } from "../lib/tags.js";
import type { BranchId } from "../db/schema.js";

interface ReviewForNotify {
  id: string;
  guestName: string;
  telegramUsername: string | null;
  visitDate: Date;
  branch: BranchId;
  dishName: string;
  comment: string;
  ratingKitchen: number | null;
  ratingBar: number;
  ratingHookah: number | null;
  ratingService: number;
  ratingOverall: number;
  tags: string[];
  driveFolderId: string | null;
  driveLinks: string[];
  sheetsRowId: number | null;
}

export async function notifyAdminsNewReview(
  row: ReviewForNotify
): Promise<void> {
  const branchLabel = BRANCH_CONFIG[row.branch].label;
  const depts = BRANCH_CONFIG[row.branch].departments;
  const kitchenLine = depts.includes("kitchen") ? `Кухня: ${row.ratingKitchen ?? "—"}/5` : "";
  const barLine = `Бар: ${row.ratingBar}/5`;
  const hookahLine = depts.includes("hookah") ? `Кальян: ${row.ratingHookah ?? "—"}/5` : "";
  const serviceLine = `Сервис: ${row.ratingService}/5`;

  const commentPreview = row.comment.length > 200 ? row.comment.slice(0, 200) + "…" : row.comment;
  const sheetsLink = getSheetsLink();
  
  const nameLine = row.telegramUsername
    ? `👤 Имя: ${row.guestName} (@${row.telegramUsername})`
    : `👤 Имя: ${row.guestName}`;
  const text = [
    "🍃 ~  Новый отзыв",
    "",
    nameLine,
    `🏢 Филиал: ${branchLabel}`,
    `📅 Визит: ${row.visitDate.toLocaleDateString("ru-RU")}`,
    `🍽️ Блюдо: ${row.dishName}`,
    "",
    "⭐ Рейтинги:",
    kitchenLine,
    barLine,
    hookahLine,
    serviceLine,
    `📊 Общий: ${row.ratingOverall}/5`,
    "",
    `🏷️ Теги: ${row.tags.length ? formatTags(row.tags) : "—"}`,
    "",
    `💬 ${commentPreview}`,
    "",
    `📷 Фото: ${row.driveLinks.length} шт.`,
    "",
    sheetsLink ? `📋 Таблица: ${sheetsLink}` : "",
  ]

    .filter(Boolean)
    .join("\n");

  for (const adminId of config.adminIds) {
    try {
      await bot.api.sendMessage(adminId, text);
      
      // Отправляем фото отдельной группой, чтобы не превысить лимит текста
      if (row.driveLinks.length > 0) {
        const media = row.driveLinks.slice(0, 10).map((link) => ({
          type: "photo" as const,
          media: link,
        }));
        await bot.api.sendMediaGroup(adminId, media);
      }
    } catch (err) {
      console.error(`Failed to notify admin ${adminId}:`, err);
  }
}

}
