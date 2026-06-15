import { google } from "googleapis";
import { config } from "../config.js";
import { db } from "../db/index.js";
import type { BranchId, ReviewRow } from "../db/schema.js";
import { syncQueue } from "../db/schema.js";
import { BRANCH_CONFIG } from "../lib/branches.js";
import { formatTagsPlain } from "../lib/tags.js";
import { createId } from "../lib/uuid.js";
import { getAuth } from "./google-auth.js";

const SHEET_NAME = config.sheetsSheetName;
const TASHKENT_TZ = "Asia/Tashkent";

/** Дата в формате DD.MM.YYYY */
function fmtDateDMY(d: Date): string {
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${day}.${month}.${d.getFullYear()}`;
}

/** created_at в формате hh:mm dd.mm.yyyy, часовой пояс Ташкент */
function fmtCreatedAtTashkent(d: Date): string {
  const formatter = new Intl.DateTimeFormat("ru-RU", {
    timeZone: TASHKENT_TZ,
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour12: false,
  });
  const parts = formatter.formatToParts(d);
  let hour = "";
  let minute = "";
  let day = "";
  let month = "";
  let year = "";
  for (const p of parts) {
    if (p.type === "hour") hour = p.value;
    if (p.type === "minute") minute = p.value;
    if (p.type === "day") day = p.value;
    if (p.type === "month") month = p.value;
    if (p.type === "year") year = p.value;
  }
  return `${hour}:${minute} ${day}.${month}.${year}`;
}

/** Парсит сохранённый комментарий в секции по цехам и общий */
function parseCommentToColumns(comment: string): {
  kitchen: string;
  bar: string;
  hookah: string;
  service: string;
  general: string;
} {
  const sections: Record<string, string> = {
    kitchen: "",
    bar: "",
    hookah: "",
    service: "",
    general: "",
  };
  const lines = comment.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const mDept = line.match(/^(Кухня|Бар|Кальян|Сервис) \([^)]+\): (.*)$/);
    if (mDept) {
      const key = {
        Кухня: "kitchen",
        Бар: "bar",
        Кальян: "hookah",
        Сервис: "service",
      }[mDept[1]];
      if (key) sections[key] = mDept[2].trim();
      i++;
      continue;
    }
    const mGeneral = line.match(/^Общий: (.*)$/);
    if (mGeneral) {
      const rest = [mGeneral[1], ...lines.slice(i + 1)].join("\n").trim();
      sections.general = rest;
      break;
    }
    i++;
  }
  if (!sections.general && !comment.includes("Общий:"))
    sections.general = comment.trim();
  return sections as {
    kitchen: string;
    bar: string;
    hookah: string;
    service: string;
    general: string;
  };
}

/**
 * Порядок колонок: ID, Дата визита, Филиал, Блюдо, Оценки (5), Комментарий Кухня/Бар/Кальян/Сервис/Общий (5), Теги, Фото (ссылка), Кол-во фото, ID, username, Дата создания.
 * Пустые оценки/фото/username → "-".
 */
export function rowToSheetValues(row: ReviewRow): string[] {
  const branch = row.branch as BranchId;
  const driveLinks = ((row.driveLinks as string[]) ?? []) as string[];
  // Используем сохраненные ссылки на фото. Если их нет, пробуем folderId (для обратной совместимости)
  const photoLinks =
    driveLinks.length > 0
      ? driveLinks.join("\n")
      : row.driveFolderId && row.driveFolderId.includes("http")
        ? row.driveFolderId
        : "-";

  const photoCount =
    driveLinks.length || ((row.photoFileIds as string[]) ?? []).length;
  const username = row.telegramUsername ? `@${row.telegramUsername}` : "-";
  const comments = parseCommentToColumns(row.comment);
  return [
    row.id,
    fmtDateDMY(row.visitDate),
    BRANCH_CONFIG[branch].label,
    row.dishName,
    row.ratingKitchen != null ? String(row.ratingKitchen) : "-",
    row.ratingBar != null ? String(row.ratingBar) : "-",
    row.ratingHookah != null ? String(row.ratingHookah) : "-",
    row.ratingService != null ? String(row.ratingService) : "-",
    row.ratingOverall != null ? String(row.ratingOverall) : "-",
    comments.kitchen || "-",
    comments.bar || "-",
    comments.hookah || "-",
    comments.service || "-",
    comments.general || "-",
    formatTagsPlain(row.tags ?? []),
    photoLinks,
    photoCount > 0 ? String(photoCount) : "-",
    String(row.telegramUserId),
    username,
    fmtCreatedAtTashkent(row.createdAt),
  ];
}

/** Заголовки: отдельные столбцы для комментариев по цехам, поле «Теги». */
export const SHEETS_HEADERS = [
  "UUID",
  "Дата Визита",
  "Название филиала",
  "Блюдо",
  "Оценка Кухня",
  "Оценка Бар",
  "Оценка Кальян",
  "Оценка Сервис",
  "Оценка Общий",
  "Комментарий (Кухня)",
  "Комментарий (Бар)",
  "Комментарий (Кальян)",
  "Комментарий (Сервис)",
  "Комментарий (Общий)",
  "Теги",
  "Фотографии(ссылки)",
  "Количество фотографий",

  "ID Пользователя",
  "username",
  "Дата создания",
];

const SHEETS_RANGE = "A:T";
const SHEETS_HEADER_RANGE = "A1:T1";

/** Убедиться, что первая строка листа — заголовки. */
async function ensureSheetHeaders(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
): Promise<void> {
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_NAME}!${SHEETS_HEADER_RANGE}`,
  });
  const firstRow = data.values?.[0];
  if (!firstRow?.length || firstRow[0] !== "UUID") {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${SHEET_NAME}!${SHEETS_HEADER_RANGE}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [SHEETS_HEADERS] },
    });
  }
}

export async function appendReviewToSheets(
  row: ReviewRow,
): Promise<number | null> {
  if (!config.sheetsSpreadsheetId) return null;
  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: "v4", auth });
    await ensureSheetHeaders(sheets, config.sheetsSpreadsheetId);
    const values = [rowToSheetValues(row)];
    const res = await sheets.spreadsheets.values.append({
      spreadsheetId: config.sheetsSpreadsheetId,
      range: `${SHEET_NAME}!${SHEETS_RANGE}`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values },
    });
    const updated = res.data.updates?.updatedRange;
    if (!updated) return null;
    const match = updated.match(/\!A(\d+)/);
    const rowIndex = match ? parseInt(match[1], 10) : null;
    return rowIndex;
  } catch (err) {
    await db.insert(syncQueue).values({
      id: createId(),
      reviewId: row.id,
      kind: "sheets",
      payload: { action: "append", row: rowToSheetValues(row) },
      lastError: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function updateReviewInSheets(
  row: ReviewRow,
  sheetsRowId: number,
): Promise<boolean> {
  if (!config.sheetsSpreadsheetId) return false;
  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: "v4", auth });
    const range = `${SHEET_NAME}!A${sheetsRowId}:T${sheetsRowId}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.sheetsSpreadsheetId,
      range,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [rowToSheetValues(row)] },
    });
    return true;
  } catch (err) {
    await db.insert(syncQueue).values({
      id: createId(),
      reviewId: row.id,
      kind: "sheets",
      payload: { action: "update", sheetsRowId, row: rowToSheetValues(row) },
      lastError: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export function getSheetsLink(): string | null {
  if (!config.sheetsSpreadsheetId) return null;
  return `https://docs.google.com/spreadsheets/d/${config.sheetsSpreadsheetId}`;
}

export function getDriveFolderLink(): string | null {
  const folderId = config.driveSharedFolderId ?? config.driveReviewsFolderId;
  if (!folderId) return null;
  return `https://drive.google.com/drive/folders/${folderId}`;
}
