import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InlineKeyboard } from "grammy";
import type { Context } from "../bot/context.js";
import { db } from "../db/index.js";
import { reviews, BRANCHES } from "../db/schema.js";
import type { BranchId } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { branchSchema } from "../lib/validation.js";
import { commentSchema } from "../lib/validation.js";
import { updateReviewInSheets } from "../services/sheets.js";
import { uploadReviewPhotos, addPhotosToExistingFolder } from "../services/drive.js";
import { getEditWhatKeyboard } from "./review-flow.js";
import { getStartKeyboard } from "./start.js";
import { BRANCH_CONFIG, getDepartmentsForBranch, DEPARTMENT_LABELS } from "../lib/branches.js";
import type { Department } from "../lib/branches.js";
import { formatTags } from "../lib/tags.js";
import { rowToReview } from "../db/review-mapper.js";
import { PHOTO_MAX_COUNT, visitDateSchema, parseVisitDate } from "../lib/validation.js";
import { PROBLEM_TAGS } from "../lib/tags.js";

const cancelKeyboard = new InlineKeyboard()
  .row({ text: "◀️ Назад", callback_data: "edit_saved:back_to_what" })
  .row({ text: "Отменить", callback_data: "edit_comment:cancel" });

/** Парсит комментарий на секции: Кухня (5): ..., Бар (4): ..., Общий: ... */
function parseCommentSections(comment: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const lines = comment.split("\n");
  for (const line of lines) {
    const mDept = line.match(/^(Кухня|Бар|Кальян|Сервис) \(\d+\): (.*)$/);
    if (mDept) {
      const key = { Кухня: "kitchen", Бар: "bar", Кальян: "hookah", Сервис: "service" }[mDept[1]];
      if (key) sections[key] = mDept[2].trim();
      continue;
    }
    const mGeneral = line.match(/^Общий: (.*)$/);
    if (mGeneral) {
      sections.general = mGeneral[1].trim();
    }
  }
  if (!sections.general && !comment.includes("Общий:")) sections.general = comment.trim();
  return sections;
}

function getRatingForDept(row: import("../db/schema.js").ReviewRow, dept: Department | string): number {
  const key = dept as string;
  if (key === "kitchen") return row.ratingKitchen ?? 0;
  if (key === "bar") return row.ratingBar ?? 0;
  if (key === "hookah") return row.ratingHookah ?? 0;
  if (key === "service") return row.ratingService ?? 0;
  return 0;
}

/** Оценка по цеху для отображения (null = пропущено) */
function getRatingForDeptDisplay(row: import("../db/schema.js").ReviewRow, dept: Department | string): number | null {
  const key = dept as string;
  if (key === "kitchen") return row.ratingKitchen ?? null;
  if (key === "bar") return row.ratingBar != null ? row.ratingBar : null;
  if (key === "hookah") return row.ratingHookah ?? null;
  if (key === "service") return row.ratingService != null ? row.ratingService : null;
  return null;
}

/** Собрать комментарий из секций по данным отзыва */
function rebuildComment(row: import("../db/schema.js").ReviewRow, sections: Record<string, string>): string {
  const depts = getDepartmentsForBranch(row.branch as BranchId);
  const lines = depts.map((d) => {
    const label = DEPARTMENT_LABELS[d];
    const rate = getRatingForDept(row, d);
    return `${label} (${rate}): ${sections[d] ?? "—"}`;
  });
  lines.push(`Общий: ${sections.general ?? ""}`);
  return lines.join("\n");
}

/** Собрать комментарий для нового филиала по секциям и новым оценкам */
function rebuildCommentForBranch(
  sections: Record<string, string>,
  branch: BranchId,
  newRatings: Record<Department, number>
): string {
  const depts = getDepartmentsForBranch(branch);
  const lines = depts.map((d) => {
    const label = DEPARTMENT_LABELS[d];
    const rate = newRatings[d] ?? 0;
    return `${label} (${rate}): ${sections[d] ?? "—"}`;
  });
  lines.push(`Общий: ${sections.general ?? ""}`);
  return lines.join("\n");
}

function getEditBranchKeyboard(): InlineKeyboard {
  const k = new InlineKeyboard();
  for (const b of BRANCHES) {
    k.row({ text: BRANCH_CONFIG[b].label, callback_data: `edit_branch:${b}` });
  }
  k.row({ text: "◀️ Назад", callback_data: "edit_saved:back_to_what" });
  return k;
}

/** Клавиатура «Что сделать с фото». Удалить/Изменить — только если фото есть. */
function getEditPhotosActionKeyboard(photoCount: number): InlineKeyboard {
  const k = new InlineKeyboard();
  k.row({ text: "Добавить", callback_data: "edit_saved:photos_add" });
  if (photoCount > 0) {
    k.row(
      { text: "Удалить", callback_data: "edit_saved:photos_remove" },
      { text: "Изменить", callback_data: "edit_saved:photos_change" }
    );
  }
  k.row({ text: "Назад", callback_data: "edit_saved:photos_back" });
  k.row({ text: "◀️ Вернуться к отзыву", callback_data: "edit_saved:back_to_review" });
  return k;
}

export async function handleReviewEditStart(ctx: Context, reviewId: string): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;
  const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
  if (!row || row.telegramUserId !== userId) {
    await ctx.answerCallbackQuery({ text: "Отзыв не найден." });
    return;
  }
  ctx.session.editingReviewId = reviewId;
  ctx.session.editSavedStep = "what";
  await ctx.answerCallbackQuery();
  await ctx.reply("Что вы хотите изменить?", {
    reply_markup: getEditWhatKeyboard("edit_saved:"),
  });
}

export async function handleReviewEditMessage(ctx: Context): Promise<boolean> {
  const reviewId = ctx.session.editingReviewId;
  const step = ctx.session.editSavedStep;
  if (!reviewId || (step !== "comment" && step !== "date")) return false;
  const text = ctx.message?.text?.trim() ?? "";

  if (step === "date") {
    const dateResult = visitDateSchema.safeParse(text);
    if (!dateResult.success) {
      await ctx.reply(dateResult.error.errors[0]?.message ?? "Неверный формат даты.");
      return true;
    }
    let visitDate: Date;
    try {
      visitDate = parseVisitDate(dateResult.data);
    } catch {
      await ctx.reply("Некорректная дата.");
      return true;
    }
    const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
    if (!row || row.telegramUserId !== ctx.from?.id) {
      delete ctx.session.editingReviewId;
      delete ctx.session.editSavedStep;
      return true;
    }
    await db.update(reviews).set({ visitDate, updatedAt: new Date(), status: "edited" }).where(eq(reviews.id, reviewId));
    if (row.sheetsRowId) {
      try {
        await updateReviewInSheets({ ...row, visitDate, updatedAt: new Date(), status: "edited" } as never, row.sheetsRowId);
      } catch {
        // queue
      }
    }
    delete ctx.session.editSavedStep;
    await ctx.reply("✅ Дата визита обновлена.", { reply_markup: getEditWhatKeyboard("edit_saved:") });
    return true;
  }

  if (step === "comment") {
    if (text === "/cancel") {
      await handleEditCommentCancel(ctx);
      return true;
    }
    if (!text) {
      await ctx.reply("Отправьте текстовый комментарий или нажмите «Отменить».");
      return true;
    }
    const result = commentSchema.safeParse(text);
    if (!result.success) {
      await ctx.reply(result.error.errors[0]?.message ?? "Минимум 10 символов.", {
        reply_markup: cancelKeyboard,
      });
      return true;
    }
    const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
    if (!row || row.telegramUserId !== ctx.from?.id) {
      delete ctx.session.editingReviewId;
      delete ctx.session.editSavedStep;
      delete ctx.session.editCommentType;
      delete ctx.session.editCommentPromptRef;
      return true;
    }
    const commentType = ctx.session.editCommentType ?? "general";
    const sections = parseCommentSections(row.comment);
    sections[commentType] = result.data;
    const newComment = rebuildComment(row, sections);
    await db.update(reviews).set({ comment: newComment, updatedAt: new Date(), status: "edited" }).where(eq(reviews.id, reviewId));
    if (row.sheetsRowId) {
      try {
        await updateReviewInSheets({ ...row, comment: newComment, updatedAt: new Date(), status: "edited" } as never, row.sheetsRowId);
      } catch {
        // queue
      }
    }
    delete ctx.session.editSavedStep;
    delete ctx.session.editCommentType;
    delete ctx.session.editCommentPromptRef;
    const keyboard = await getStartKeyboard(ctx);
    await ctx.reply("✅ Комментарий обновлён.", { reply_markup: keyboard });
    return true;
  }

  return false;
}

/** Показать выбор типа комментария (Общий, Кухня, Бар и т.д.) */
function getCommentTypeKeyboard(branch: string): InlineKeyboard {
  const depts = getDepartmentsForBranch(branch as import("../db/schema.js").BranchId);
  const k = new InlineKeyboard();
  k.row({ text: "Общий", callback_data: "edit_comment_type:general" });
  for (const d of depts) {
    k.row({ text: DEPARTMENT_LABELS[d as Department], callback_data: `edit_comment_type:${d}` });
  }
  k.row({ text: "◀️ Назад", callback_data: "edit_saved:back_to_what" });
  k.row({ text: "Отменить", callback_data: "edit_comment:cancel" });
  return k;
}

/** Обработка выбора «Комментарий»: сначала спросить тип (Общий / Кухня / Бар …) */
export async function handleEditSavedComment(ctx: Context): Promise<void> {
  const reviewId = ctx.session.editingReviewId;
  if (!reviewId) return;
  const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
  if (!row || row.telegramUserId !== ctx.from?.id) {
    await ctx.answerCallbackQuery({ text: "Отзыв не найден." });
    return;
  }
  ctx.session.editSavedStep = "comment_type";
  await ctx.answerCallbackQuery();
  const keyboard = getCommentTypeKeyboard(row.branch);
  await ctx.reply("Какой тип комментария вы хотите изменить?", { reply_markup: keyboard });
}

/** Клавиатура экрана «текущий комментарий»: Назад / Удалить / Изменить */
function getCommentShowKeyboard(): InlineKeyboard {
  return new InlineKeyboard([
    [
      { text: "◀️ Назад", callback_data: "edit_comment_action:back" },
      { text: "Удалить", callback_data: "edit_comment_action:delete" },
      { text: "Изменить", callback_data: "edit_comment_action:edit" },
    ],
    [{ text: "Отменить", callback_data: "edit_comment:cancel" }],
  ]);
}

/** Выбор типа комментария: показываем текущий комментарий и кнопки Назад / Удалить / Изменить */
export async function handleEditCommentType(ctx: Context, commentType: string): Promise<void> {
  const reviewId = ctx.session.editingReviewId;
  if (!reviewId) return;
  const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
  if (!row || row.telegramUserId !== ctx.from?.id) {
    await ctx.answerCallbackQuery({ text: "Отзыв не найден." });
    return;
  }
  const typeLabels: Record<string, string> = {
    general: "Общий",
    kitchen: "Кухня",
    bar: "Бар",
    hookah: "Кальян",
    service: "Сервис",
  };
  const label = typeLabels[commentType] ?? commentType;
  const sections = parseCommentSections(row.comment);
  const currentText = sections[commentType]?.trim() ?? "";
  ctx.session.editCommentType = commentType;
  ctx.session.editSavedStep = "comment_show";
  await ctx.answerCallbackQuery();
  if (currentText) {
    await ctx.reply(
      `Ваш текущий комментарий к «${label}»:\n\n${currentText}`,
      { reply_markup: getCommentShowKeyboard() }
    );
  } else {
    await ctx.reply(
      `Вы добавляете комментарий к «${label}».`,
      { reply_markup: getCommentShowKeyboard() }
    );
  }
}

/** Действие на экране комментария: Назад (к выбору типа) / Удалить / Изменить */
export async function handleEditCommentAction(ctx: Context, action: "back" | "delete" | "edit"): Promise<void> {
  const reviewId = ctx.session.editingReviewId;
  const commentType = ctx.session.editCommentType;
  if (!reviewId || !commentType) return;
  const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
  if (!row || row.telegramUserId !== ctx.from?.id) {
    await ctx.answerCallbackQuery({ text: "Отзыв не найден." });
    return;
  }
  await ctx.answerCallbackQuery();
  if (action === "back") {
    ctx.session.editSavedStep = "comment_type";
    await ctx.reply("Какой тип комментария вы хотите изменить?", {
      reply_markup: getCommentTypeKeyboard(row.branch),
    });
    return;
  }
  if (action === "delete") {
    const sections = parseCommentSections(row.comment);
    sections[commentType] = "";
    const newComment = rebuildComment(row, sections);
    await db.update(reviews).set({ comment: newComment, updatedAt: new Date(), status: "edited" }).where(eq(reviews.id, reviewId));
    if (row.sheetsRowId) {
      try {
        await updateReviewInSheets({ ...row, comment: newComment, updatedAt: new Date(), status: "edited" } as never, row.sheetsRowId);
      } catch {
        /* queue */
      }
    }
    delete ctx.session.editSavedStep;
    delete ctx.session.editCommentType;
    await ctx.reply("✅ Комментарий удалён.", { reply_markup: getEditWhatKeyboard("edit_saved:") });
    return;
  }
  if (action === "edit") {
    const typeLabels: Record<string, string> = {
      general: "Общий",
      kitchen: "Кухня",
      bar: "Бар",
      hookah: "Кальян",
      service: "Сервис",
    };
    const label = typeLabels[commentType] ?? commentType;
    ctx.session.editSavedStep = "comment";
    const msg = await ctx.reply(
      `Введите новый комментарий для «${label}» (10–1000 символов). Можно /cancel или кнопка «Отменить».`,
      { reply_markup: cancelKeyboard }
    );
    ctx.session.editCommentPromptRef = { chatId: msg.chat.id, messageId: msg.message_id };
  }
}

/** Отмена редактирования комментария: удаляем сообщение-подсказку, возврат в меню «Что изменить» */
export async function handleEditCommentCancel(ctx: Context): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCallbackQuery();
  const ref = ctx.session.editCommentPromptRef;
  if (ref) {
    try {
      await ctx.api.deleteMessage(ref.chatId, ref.messageId);
    } catch {
      // ignore
    }
    delete ctx.session.editCommentPromptRef;
  }
  delete ctx.session.editCommentType;
  ctx.session.editSavedStep = "what";
  await ctx.reply("Что вы хотите изменить?", { reply_markup: getEditWhatKeyboard("edit_saved:") });
}

/** Редактирование даты визита */
export async function handleEditSavedDate(ctx: Context): Promise<void> {
  const reviewId = ctx.session.editingReviewId;
  if (!reviewId) return;
  const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
  if (!row || row.telegramUserId !== ctx.from?.id) {
    await ctx.answerCallbackQuery({ text: "Отзыв не найден." });
    return;
  }
  ctx.session.editSavedStep = "date";
  await ctx.answerCallbackQuery();
  const dateKb = new InlineKeyboard();
  dateKb.row(
    { text: "Сегодня", callback_data: "edit_date:today" },
    { text: "Вчера", callback_data: "edit_date:yesterday" },
    { text: "Послевчера", callback_data: "edit_date:day_before" }
  );
  dateKb.row({ text: "◀️ Назад", callback_data: "edit_saved:back_to_what" });
  dateKb.row({ text: "Отменить", callback_data: "edit_saved:back" });
  await ctx.reply("Дата визита: выберите кнопку или введите ДД.ММ.ГГГГ", { reply_markup: dateKb });
}

/** Обработка кнопки даты (Сегодня / Вчера / Послевчера) */
export async function handleEditDateChoice(ctx: Context, choice: "today" | "yesterday" | "day_before"): Promise<void> {
  const reviewId = ctx.session.editingReviewId;
  if (!reviewId) return;
  const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
  if (!row || row.telegramUserId !== ctx.from?.id) {
    await ctx.answerCallbackQuery({ text: "Отзыв не найден." });
    return;
  }
  const input = choice === "today" ? "Сегодня" : choice === "yesterday" ? "Вчера" : "Послевчера";
  const visitDate = parseVisitDate(input);
  await db.update(reviews).set({ visitDate, updatedAt: new Date(), status: "edited" }).where(eq(reviews.id, reviewId));
  if (row.sheetsRowId) {
    try {
      await updateReviewInSheets({ ...row, visitDate, updatedAt: new Date(), status: "edited" } as never, row.sheetsRowId);
    } catch {
      // queue
    }
  }
  delete ctx.session.editSavedStep;
  await ctx.answerCallbackQuery({ text: "Дата обновлена." });
  await ctx.reply("✅ Дата визита обновлена.", { reply_markup: getEditWhatKeyboard("edit_saved:") });
}

/** Назад в меню «Что изменить» без выхода из редактирования отзыва */
export async function handleEditSavedBackToWhat(ctx: Context): Promise<void> {
  ctx.session.editSavedStep = "what";
  delete ctx.session.editCommentType;
  delete ctx.session.editSavedBranchNewBranch;
  delete ctx.session.editSavedBranchRatings;
  const ref = ctx.session.editCommentPromptRef;
  if (ref) {
    try {
      await ctx.api.deleteMessage(ref.chatId, ref.messageId);
    } catch {
      // ignore
    }
    delete ctx.session.editCommentPromptRef;
  }
  await ctx.answerCallbackQuery();
  await ctx.reply("Что вы хотите изменить?", {
    reply_markup: getEditWhatKeyboard("edit_saved:"),
  });
}

/** Назад из подменю «Фото» — вернуться к «Что изменить» */
export async function handleEditSavedPhotosBack(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery();
  await ctx.reply("Что вы хотите изменить?", {
    reply_markup: getEditWhatKeyboard("edit_saved:"),
  });
}

/** Назад из меню «Что изменить» — вернуться к просмотру отзыва */
export async function handleEditSavedBack(ctx: Context): Promise<void> {
  const reviewId = ctx.session.editingReviewId;
  delete ctx.session.editingReviewId;
  delete ctx.session.editSavedStep;
  delete ctx.session.editPhotoIndex;
  await ctx.answerCallbackQuery();
  if (reviewId) {
    const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
    if (row && row.telegramUserId === ctx.from?.id) {
      const review = rowToReview(row);
      const branchLabel = BRANCH_CONFIG[review.branch].label;
      const lines = [
        `👤 ${review.guestName}`,
        `📅 ${review.visitDate.toLocaleDateString("ru-RU")}`,
        `🏢 ${branchLabel}`,
        `🍽️ ${review.dishName}`,
        `💬 ${review.comment}`,
        `⭐ Общий рейтинг: ${review.ratings.overall}/5`,
        `🏷️ ${review.tags.length ? formatTags(review.tags) : "—"}`,
        `📷 Фото: ${review.photos.driveLinks.length || review.photos.fileIds.length} шт.`,
      ];
      const keyboard = new InlineKeyboard();
      keyboard.add({ text: "Изменить", callback_data: `review_edit:${reviewId}` });
      keyboard.add({ text: "Назад к списку", callback_data: "menu:my_reviews" });
      await ctx.reply(lines.join("\n"), { reply_markup: keyboard });
      return;
    }
  }
  const keyboard = await getStartKeyboard(ctx);
  await ctx.reply("Выберите действие:", { reply_markup: keyboard });
}

/** Меню «Что сделать с фото»: Добавить; Удалить/Изменить только при наличии фото */
export async function handleEditSavedPhotos(ctx: Context): Promise<void> {
  const reviewId = ctx.session.editingReviewId;
  if (!reviewId) return;
  const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
  if (!row || row.telegramUserId !== ctx.from?.id) {
    await ctx.answerCallbackQuery({ text: "Отзыв не найден." });
    return;
  }
  const photoCount = (row.photoFileIds as string[])?.length ?? 0;
  await ctx.answerCallbackQuery();
  await ctx.reply("Что вы хотите сделать с фотографиями?", {
    reply_markup: getEditPhotosActionKeyboard(photoCount),
  });
}

const EDIT_PHOTOS_ADD_KB = new InlineKeyboard([
  [{ text: "Готово", callback_data: "edit_photos_add:done" }],
  [{ text: "Отмена", callback_data: "edit_photos_add:cancel" }],
]);

/** Фото: Добавить — сбор новых фото, загрузка в Drive, обновление отзыва */
export async function handleEditSavedPhotosAdd(ctx: Context): Promise<void> {
  const reviewId = ctx.session.editingReviewId;
  if (!reviewId) return;
  const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
  if (!row || row.telegramUserId !== ctx.from?.id) {
    await ctx.answerCallbackQuery({ text: "Отзыв не найден." });
    return;
  }
  const currentCount = (row.photoFileIds as string[])?.length ?? 0;
  const canAdd = Math.max(0, PHOTO_MAX_COUNT - currentCount);
  if (canAdd === 0) {
    await ctx.answerCallbackQuery();
    await ctx.reply(`В отзыве уже максимум ${PHOTO_MAX_COUNT} фото.`, { reply_markup: getEditWhatKeyboard("edit_saved:") });
    return;
  }
  ctx.session.editSavedStep = "photos_add";
  ctx.session.editSavedNewPhotoIds = [];
  await ctx.answerCallbackQuery();
  await ctx.reply(
    `Отправьте до ${canAdd} фото. Затем нажмите «Готово».`,
    { reply_markup: EDIT_PHOTOS_ADD_KB }
  );
}

/** Обработка фото при добавлении к отзыву (editSavedStep === "photos_add") */
export async function handleEditSavedPhotosAddMessage(ctx: Context): Promise<boolean> {
  const reviewId = ctx.session.editingReviewId;
  if (!reviewId || ctx.session.editSavedStep !== "photos_add") return false;
  const photo = ctx.message?.photo;
  if (!photo?.length) return false;
  const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
  if (!row || row.telegramUserId !== ctx.from?.id) {
    delete ctx.session.editSavedStep;
    delete ctx.session.editSavedNewPhotoIds;
    return false;
  }
  const currentCount = (row.photoFileIds as string[])?.length ?? 0;
  const canAdd = Math.max(0, PHOTO_MAX_COUNT - currentCount);
  const newIds = ctx.session.editSavedNewPhotoIds ?? [];
  if (newIds.length >= canAdd) {
    await ctx.reply(`Достигнут лимит: можно добавить не более ${canAdd} фото. Нажмите «Готово».`, {
      reply_markup: EDIT_PHOTOS_ADD_KB,
    });
    return true;
  }
  const fileId = photo[photo.length - 1].file_id;
  newIds.push(fileId);
  ctx.session.editSavedNewPhotoIds = newIds;
  await ctx.reply(
    `📷 Добавлено фото (${newIds.length} из ${canAdd}). Отправьте ещё или нажмите «Готово».`,
    { reply_markup: EDIT_PHOTOS_ADD_KB }
  );
  return true;
}

/** Завершить добавление фото: загрузить в Drive, обновить отзыв */
export async function handleEditPhotosAddDone(ctx: Context): Promise<void> {
  const reviewId = ctx.session.editingReviewId;
  const newIds = ctx.session.editSavedNewPhotoIds ?? [];
  if (!reviewId || newIds.length === 0) {
    await ctx.answerCallbackQuery();
    delete ctx.session.editSavedStep;
    delete ctx.session.editSavedNewPhotoIds;
    await ctx.reply("Фото не добавлены.", { reply_markup: getEditWhatKeyboard("edit_saved:") });
    return;
  }
  const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
  if (!row || row.telegramUserId !== ctx.from?.id) {
    await ctx.answerCallbackQuery({ text: "Отзыв не найден." });
    delete ctx.session.editSavedStep;
    delete ctx.session.editSavedNewPhotoIds;
    return;
  }
  await ctx.answerCallbackQuery({ text: "Загружаем фото…" });

  const getFileBuffer = async (fileId: string) => {
    const file = await ctx.api.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Failed to download file");
    return Buffer.from(await res.arrayBuffer());
  };

  let newDriveLinks: string[] = [];
  let tempDir: string | null = null;
  try {
    tempDir = await mkdtemp(join(tmpdir(), `rsxr-add-${reviewId}-`));
    const pathByIndex: string[] = [];
    const { writeFile } = await import("node:fs/promises");
    for (let i = 0; i < newIds.length; i++) {
      const buf = await getFileBuffer(newIds[i]);
      const ext = buf[0] === 0xff && buf[1] === 0xd8 ? "jpg" : "png";
      const localPath = join(tempDir, `photo_${i}.${ext}`);
      await writeFile(localPath, buf);
      pathByIndex.push(localPath);
    }
    const getBufferFromTemp = async (fileId: string) => {
      const idx = newIds.indexOf(fileId);
      if (idx === -1) throw new Error("Unknown fileId");
      return readFile(pathByIndex[idx]);
    };

    if (row.driveFolderId) {
      newDriveLinks = await addPhotosToExistingFolder(
        row.driveFolderId,
        newIds,
        getBufferFromTemp
      );
    } else {
      const upload = await uploadReviewPhotos(
        row.branch as never,
        row.visitDate,
        reviewId,
        newIds,
        getBufferFromTemp
      );
      if (upload) {
        newDriveLinks = upload.fileLinks;
        await db
          .update(reviews)
          .set({
            driveFolderId: upload.folderId,
            updatedAt: new Date(),
            status: "edited",
          })
          .where(eq(reviews.id, reviewId));
      }
    }
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }

  const updatedFileIds = [...((row.photoFileIds as string[]) ?? []), ...newIds];
  const updatedDriveLinks = [...((row.driveLinks as string[]) ?? []), ...newDriveLinks];
  await db
    .update(reviews)
    .set({
      photoFileIds: updatedFileIds,
      driveLinks: updatedDriveLinks,
      updatedAt: new Date(),
      status: "edited",
    })
    .where(eq(reviews.id, reviewId));

  if (row.sheetsRowId) {
    try {
      const updated = {
        ...row,
        photoFileIds: updatedFileIds,
        driveLinks: updatedDriveLinks,
        updatedAt: new Date(),
        status: "edited" as const,
      };
      await updateReviewInSheets(updated as never, row.sheetsRowId);
    } catch {
      // sync queue
    }
  }

  delete ctx.session.editSavedStep;
  delete ctx.session.editSavedNewPhotoIds;
  await ctx.reply("✅ Фото добавлены к отзыву.", { reply_markup: getEditWhatKeyboard("edit_saved:") });
}

/** Отмена добавления фото */
export async function handleEditPhotosAddCancel(ctx: Context): Promise<void> {
  delete ctx.session.editSavedStep;
  delete ctx.session.editSavedNewPhotoIds;
  await ctx.answerCallbackQuery();
  await ctx.reply("Что вы хотите изменить?", { reply_markup: getEditWhatKeyboard("edit_saved:") });
}

/** Фото: Удалить все — подтверждение и удаление */
export async function handleEditSavedPhotosRemove(ctx: Context): Promise<void> {
  const reviewId = ctx.session.editingReviewId;
  if (!reviewId) return;
  const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
  if (!row || row.telegramUserId !== ctx.from?.id) {
    await ctx.answerCallbackQuery({ text: "Отзыв не найден." });
    return;
  }
  await ctx.answerCallbackQuery();
  const fileIds = (row.photoFileIds as string[]) ?? [];
  if (fileIds.length === 0) {
    await ctx.reply("В отзыве нет фотографий.", { reply_markup: getEditWhatKeyboard("edit_saved:") });
    return;
  }
  await db
    .update(reviews)
    .set({
      photoFileIds: [],
      driveLinks: [],
      driveFolderId: null,
      updatedAt: new Date(),
      status: "edited",
    })
    .where(eq(reviews.id, reviewId));
  if (row.sheetsRowId) {
    try {
      const updated = { ...row, photoFileIds: [], driveLinks: [], driveFolderId: null, updatedAt: new Date(), status: "edited" as const };
      await updateReviewInSheets(updated as never, row.sheetsRowId);
    } catch {
      // sync queue
    }
  }
  delete ctx.session.editSavedStep;
  await ctx.reply("✅ Все фотографии удалены из отзыва.", { reply_markup: getEditWhatKeyboard("edit_saved:") });
}

/** Фото: Изменить — показать каждое фото отдельным сообщением с кнопками Удалить / Назад */
export async function handleEditSavedPhotosChange(ctx: Context): Promise<void> {
  const reviewId = ctx.session.editingReviewId;
  if (!reviewId) return;
  const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
  if (!row || row.telegramUserId !== ctx.from?.id) {
    await ctx.answerCallbackQuery({ text: "Отзыв не найден." });
    return;
  }
  const fileIds = (row.photoFileIds as string[]) ?? [];
  await ctx.answerCallbackQuery();
  if (fileIds.length === 0) {
    await ctx.reply("В отзыве нет фотографий.", { reply_markup: getEditWhatKeyboard("edit_saved:") });
    return;
  }
  ctx.session.editSavedStep = "photos_remove_one";
  ctx.session.editPhotoIndex = 0;
  await sendPhotoChoiceAndKeyboard(ctx, reviewId, fileIds, 0);
}

function getPhotoChoiceKeyboard(reviewId: string, index: number, total: number): InlineKeyboard {
  const k = new InlineKeyboard();
  k.row(
    { text: "Удалить", callback_data: `edit_photo_del:${reviewId}:${index}` },
    { text: "Назад", callback_data: "edit_saved:photos_back_from_one" }
  );
  if (total > 1) {
    const prev = index > 0 ? index - 1 : total - 1;
    const next = index < total - 1 ? index + 1 : 0;
    k.row(
      { text: "◀️ Пред.", callback_data: `edit_photo_idx:${reviewId}:${prev}` },
      { text: "▶️ След.", callback_data: `edit_photo_idx:${reviewId}:${next}` }
    );
  }
  return k;
}

async function sendPhotoChoiceAndKeyboard(ctx: Context, reviewId: string, fileIds: string[], index: number): Promise<void> {
  const fileId = fileIds[index];
  const total = fileIds.length;
  await ctx.replyWithPhoto(fileId, {
    caption: `Фото ${index + 1} из ${total}. Удалить это фото или вернуться?`,
    reply_markup: getPhotoChoiceKeyboard(reviewId, index, total),
  });
}

/** Удалить одно фото по индексу */
export async function handleEditPhotoDelete(ctx: Context, reviewId: string, indexStr: string): Promise<void> {
  const index = parseInt(indexStr, 10);
  const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
  if (!row || row.telegramUserId !== ctx.from?.id) {
    await ctx.answerCallbackQuery({ text: "Отзыв не найден." });
    return;
  }
  const fileIds = (row.photoFileIds as string[]) ?? [];
  if (index < 0 || index >= fileIds.length) {
    await ctx.answerCallbackQuery({ text: "Неверный индекс." });
    return;
  }
  const newFileIds = fileIds.filter((_, i) => i !== index);
  const newDriveLinks = ((row.driveLinks as string[]) ?? []).filter((_, i) => i !== index);
  await db
    .update(reviews)
    .set({
      photoFileIds: newFileIds,
      driveLinks: newDriveLinks.length ? newDriveLinks : (row.driveFolderId ? [] : []),
      updatedAt: new Date(),
      status: "edited",
    })
    .where(eq(reviews.id, reviewId));
  if (row.sheetsRowId) {
    try {
      const updated = {
        ...row,
        photoFileIds: newFileIds,
        driveLinks: newDriveLinks,
        updatedAt: new Date(),
        status: "edited" as const,
      };
      await updateReviewInSheets(updated as never, row.sheetsRowId);
    } catch {
      // sync
    }
  }
  await ctx.answerCallbackQuery({ text: "Фото удалено." });
  const msg = ctx.callbackQuery?.message;
  if (msg && "message_id" in msg && msg.chat?.id) {
    await ctx.api.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
  }
  if (newFileIds.length === 0) {
    delete ctx.session.editSavedStep;
    delete ctx.session.editPhotoIndex;
    await ctx.reply("В отзыве больше нет фотографий.", { reply_markup: getEditWhatKeyboard("edit_saved:") });
    return;
  }
  const newIndex = Math.min(index, newFileIds.length - 1);
  ctx.session.editPhotoIndex = newIndex;
  await sendPhotoChoiceAndKeyboard(ctx, reviewId, newFileIds, newIndex);
}

/** Переключить индекс фото (◀️ / ▶️) */
export async function handleEditPhotoIndex(ctx: Context, reviewId: string, indexStr: string): Promise<void> {
  const index = parseInt(indexStr, 10);
  const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
  if (!row || row.telegramUserId !== ctx.from?.id) return;
  const fileIds = (row.photoFileIds as string[]) ?? [];
  if (index < 0 || index >= fileIds.length) return;
  await ctx.answerCallbackQuery();
  ctx.session.editPhotoIndex = index;
  await sendPhotoChoiceAndKeyboard(ctx, reviewId, fileIds, index);
}

/** Назад из просмотра одного фото — вернуться к «Что сделать с фото» */
export async function handleEditSavedPhotosBackFromOne(ctx: Context): Promise<void> {
  delete ctx.session.editPhotoIndex;
  ctx.session.editSavedStep = "what";
  await ctx.answerCallbackQuery();
  await ctx.reply("Что вы хотите изменить?", { reply_markup: getEditWhatKeyboard("edit_saved:") });
}

const TAGS_PAGE_SIZE = 3;

function getEditTagsKeyboard(selected: string[], page: number): InlineKeyboard {
  const from = page * TAGS_PAGE_SIZE;
  const slice = PROBLEM_TAGS.slice(from, from + TAGS_PAGE_SIZE);
  const k = new InlineKeyboard();
  for (const t of slice) {
    const mark = selected.includes(t.id) ? " ✔️" : "";
    k.row({ text: t.shortLabel + mark, callback_data: `edit_tags:tag:${t.id}` });
  }
  const nav: { text: string; callback_data: string }[] = [];
  if (page > 0) nav.push({ text: "◀️ Назад", callback_data: `edit_tags:page:${page - 1}` });
  if (from + TAGS_PAGE_SIZE < PROBLEM_TAGS.length) nav.push({ text: "Вперёд ▶️", callback_data: `edit_tags:page:${page + 1}` });
  if (nav.length) k.row(...nav);
  k.row({ text: "Готово", callback_data: "edit_tags:done" });
  k.row({ text: "Отменить", callback_data: "edit_saved:back" });
  return k;
}

/** Редактирование тегов */
export async function handleEditSavedTags(ctx: Context): Promise<void> {
  const reviewId = ctx.session.editingReviewId;
  if (!reviewId) return;
  const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
  if (!row || row.telegramUserId !== ctx.from?.id) {
    await ctx.answerCallbackQuery({ text: "Отзыв не найден." });
    return;
  }
  ctx.session.editSavedStep = "tags";
  ctx.session.editSavedTagsSelection = [...((row.tags as string[]) ?? [])];
  ctx.session.editSavedTagsPage = 0;
  await ctx.answerCallbackQuery();
  await ctx.reply("Выберите теги (повторное нажатие снимает выбор), затем «Готово»:", {
    reply_markup: getEditTagsKeyboard(ctx.session.editSavedTagsSelection, 0),
  });
}

/** Переключение тега или страницы при редактировании тегов */
export async function handleEditTagsCallback(ctx: Context, data: string): Promise<void> {
  const reviewId = ctx.session.editingReviewId;
  if (!reviewId || ctx.session.editSavedStep !== "tags") return;
  const selection = ctx.session.editSavedTagsSelection ?? [];
  if (data.startsWith("edit_tags:tag:")) {
    const id = data.slice("edit_tags:tag:".length);
    const idx = selection.indexOf(id);
    if (idx !== -1) selection.splice(idx, 1);
    else selection.push(id);
    ctx.session.editSavedTagsSelection = selection;
    const page = ctx.session.editSavedTagsPage ?? 0;
    await ctx.answerCallbackQuery();
    try {
      const msg = ctx.callbackQuery?.message;
      if (msg && "message_id" in msg && msg.chat?.id) {
        await ctx.api.editMessageReplyMarkup(msg.chat.id, msg.message_id, {
          reply_markup: getEditTagsKeyboard(selection, page),
        });
      }
    } catch {
      await ctx.reply("Теги обновлены. Нажмите «Готово» или выберите ещё:", {
        reply_markup: getEditTagsKeyboard(selection, page),
      });
    }
    return;
  }
  if (data.startsWith("edit_tags:page:")) {
    const page = Math.max(0, parseInt(data.slice("edit_tags:page:".length), 10));
    const totalPages = Math.ceil(PROBLEM_TAGS.length / TAGS_PAGE_SIZE);
    const safePage = Math.min(page, totalPages - 1);
    ctx.session.editSavedTagsPage = safePage;
    await ctx.answerCallbackQuery();
    const msg = ctx.callbackQuery?.message;
    if (msg && "message_id" in msg && msg.chat?.id) {
      try {
        await ctx.api.editMessageReplyMarkup(msg.chat.id, msg.message_id, {
          reply_markup: getEditTagsKeyboard(selection, safePage),
        });
      } catch {
        await ctx.reply("Теги:", { reply_markup: getEditTagsKeyboard(selection, safePage) });
      }
    }
    return;
  }
  if (data === "edit_tags:done") {
    const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
    if (!row || row.telegramUserId !== ctx.from?.id) {
      await ctx.answerCallbackQuery({ text: "Отзыв не найден." });
      return;
    }
    const newTags = ctx.session.editSavedTagsSelection ?? [];
    await db.update(reviews).set({ tags: newTags, updatedAt: new Date(), status: "edited" }).where(eq(reviews.id, reviewId));
    if (row.sheetsRowId) {
      try {
        await updateReviewInSheets({ ...row, tags: newTags, updatedAt: new Date(), status: "edited" } as never, row.sheetsRowId);
      } catch {
        // queue
      }
    }
    delete ctx.session.editSavedStep;
    delete ctx.session.editSavedTagsSelection;
    delete ctx.session.editSavedTagsPage;
    await ctx.answerCallbackQuery({ text: "Теги сохранены." });
    const msg = ctx.callbackQuery?.message;
    if (msg && "message_id" in msg && msg.chat?.id) {
      await ctx.api.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
    }
    await ctx.reply("✅ Теги обновлены.", { reply_markup: getEditWhatKeyboard("edit_saved:") });
  }
}

/** Клавиатура выбора цеха для смены оценки: «Кухня — 5», «Бар — 4» и т.д. */
function getRatingDeptKeyboard(branch: string, row: import("../db/schema.js").ReviewRow): InlineKeyboard {
  const depts = getDepartmentsForBranch(branch as import("../db/schema.js").BranchId);
  const k = new InlineKeyboard();
  for (const d of depts) {
    const score = getRatingForDeptDisplay(row, d);
    const label = DEPARTMENT_LABELS[d as Department];
    const text = score != null ? `${label} — ${score}` : `${label} — —`;
    k.row({
      text,
      callback_data: `edit_rating_choose:${d}`,
    });
  }
  k.row({ text: "◀️ Назад", callback_data: "edit_saved:back_to_what" });
  return k;
}

/** Редактирование оценок: сначала «Какую оценку поменять?», затем 1–5 */
export async function handleEditSavedRatings(ctx: Context): Promise<void> {
  const reviewId = ctx.session.editingReviewId;
  if (!reviewId) return;
  const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
  if (!row || row.telegramUserId !== ctx.from?.id) {
    await ctx.answerCallbackQuery({ text: "Отзыв не найден." });
    return;
  }
  ctx.session.editSavedStep = "ratings_choose_dept";
  delete ctx.session.editSavedRatingDept;
  await ctx.answerCallbackQuery();
  await ctx.reply("Какую оценку вы хотите изменить?", {
    reply_markup: getRatingDeptKeyboard(row.branch, row),
  });
}

/** Выбран цех для смены оценки — показать 1–5 */
export async function handleEditRatingChooseDept(ctx: Context, dept: string): Promise<void> {
  const reviewId = ctx.session.editingReviewId;
  if (!reviewId || ctx.session.editSavedStep !== "ratings_choose_dept") return;
  const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
  if (!row || row.telegramUserId !== ctx.from?.id) {
    await ctx.answerCallbackQuery({ text: "Отзыв не найден." });
    return;
  }
  const label = DEPARTMENT_LABELS[dept as Department];
  ctx.session.editSavedStep = "ratings";
  ctx.session.editSavedRatingDept = dept;
  const ratingKb = new InlineKeyboard();
  ratingKb.row(
    { text: "1", callback_data: `edit_rating:${dept}:1` },
    { text: "2", callback_data: `edit_rating:${dept}:2` },
    { text: "3", callback_data: `edit_rating:${dept}:3` },
    { text: "4", callback_data: `edit_rating:${dept}:4` },
    { text: "5", callback_data: `edit_rating:${dept}:5` }
  );
  ratingKb.row({ text: "◀️ Назад", callback_data: "edit_saved:ratings_back" });
  await ctx.answerCallbackQuery();
  await ctx.reply(`Оценка: ${label} (1–5)`, { reply_markup: ratingKb });
}

/** Назад из экрана 1–5 к выбору «Какую оценку поменять?» */
export async function handleEditSavedRatingsBack(ctx: Context): Promise<void> {
  const reviewId = ctx.session.editingReviewId;
  if (!reviewId) return;
  const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
  if (!row || row.telegramUserId !== ctx.from?.id) {
    await ctx.answerCallbackQuery();
    return;
  }
  ctx.session.editSavedStep = "ratings_choose_dept";
  delete ctx.session.editSavedRatingDept;
  await ctx.answerCallbackQuery();
  await ctx.reply("Какую оценку вы хотите изменить?", {
    reply_markup: getRatingDeptKeyboard(row.branch, row),
  });
}

/** Обработка выбора оценки при редактировании (одна оценка — выбранный цех) */
export async function handleEditRatingChoice(ctx: Context, dept: string, score: number): Promise<void> {
  const reviewId = ctx.session.editingReviewId;
  if (!reviewId || ctx.session.editSavedStep !== "ratings") return;
  const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
  if (!row || row.telegramUserId !== ctx.from?.id) {
    await ctx.answerCallbackQuery({ text: "Отзыв не найден." });
    return;
  }
  const depts = getDepartmentsForBranch(row.branch as import("../db/schema.js").BranchId);
  const updates: Partial<typeof row> = { updatedAt: new Date(), status: "edited" };
  if (dept === "kitchen") updates.ratingKitchen = score;
  else if (dept === "bar") updates.ratingBar = score;
  else if (dept === "hookah") updates.ratingHookah = score;
  else if (dept === "service") updates.ratingService = score;
  const merged = { ...row, ...updates };
  const sumRatings = (depts as Department[]).reduce(
    (s: number, d: Department) => s + getRatingForDept(merged as typeof row, d),
    0
  );
  const ratingOverall = Math.round(sumRatings / depts.length);
  await db
    .update(reviews)
    .set({ ...updates, ratingOverall, updatedAt: new Date(), status: "edited" })
    .where(eq(reviews.id, reviewId));
  const [updatedRow] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
  if (row.sheetsRowId && updatedRow) {
    try {
      await updateReviewInSheets(updatedRow as never, row.sheetsRowId);
    } catch {
      // queue
    }
  }
  delete ctx.session.editSavedStep;
  delete ctx.session.editSavedRatingDept;
  delete ctx.session.editSavedRatingDeptIndex;
  await ctx.answerCallbackQuery({ text: "Оценка сохранена." });
  await ctx.reply("✅ Оценки обновлены.", { reply_markup: getEditWhatKeyboard("edit_saved:") });
}

/** Редактирование заведения: выбор нового филиала, затем оценки по цехам */
export async function handleEditSavedBranch(ctx: Context): Promise<void> {
  const reviewId = ctx.session.editingReviewId;
  if (!reviewId) return;
  const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
  if (!row || row.telegramUserId !== ctx.from?.id) {
    await ctx.answerCallbackQuery({ text: "Отзыв не найден." });
    return;
  }
  ctx.session.editSavedStep = "branch_choose";
  await ctx.answerCallbackQuery();
  await ctx.reply("Выберите новое заведение:", {
    reply_markup: getEditBranchKeyboard(),
  });
}

/** Выбран новый филиал — начинаем сбор оценок по цехам нового филиала */
export async function handleEditBranchChoice(ctx: Context, branchId: string): Promise<void> {
  const reviewId = ctx.session.editingReviewId;
  if (!reviewId || ctx.session.editSavedStep !== "branch_choose") return;
  const branchResult = branchSchema.safeParse(branchId);
  if (!branchResult.success) {
    await ctx.answerCallbackQuery({ text: "Неверный филиал." });
    return;
  }
  const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
  if (!row || row.telegramUserId !== ctx.from?.id) {
    await ctx.answerCallbackQuery({ text: "Отзыв не найден." });
    return;
  }
  const newBranch = branchResult.data as BranchId;
  const depts = getDepartmentsForBranch(newBranch);
  ctx.session.editSavedStep = "branch_ratings";
  ctx.session.editSavedBranchNewBranch = newBranch;
  ctx.session.editSavedBranchRatings = {};
  ctx.session.editSavedRatingDeptIndex = 0;
  const dept = depts[0];
  const label = DEPARTMENT_LABELS[dept as Department];
  const ratingKb = new InlineKeyboard();
  ratingKb.row(
    { text: "1", callback_data: `edit_branch_rating:${dept}:1` },
    { text: "2", callback_data: `edit_branch_rating:${dept}:2` },
    { text: "3", callback_data: `edit_branch_rating:${dept}:3` },
    { text: "4", callback_data: `edit_branch_rating:${dept}:4` },
    { text: "5", callback_data: `edit_branch_rating:${dept}:5` }
  );
  ratingKb.row({ text: "◀️ Назад", callback_data: "edit_saved:back_to_what" });
  await ctx.answerCallbackQuery();
  await ctx.reply(`Новое заведение: ${BRANCH_CONFIG[newBranch].label}. Оценка: ${label} (1–5)`, {
    reply_markup: ratingKb,
  });
}

/** Выбор оценки по цеху при смене заведения */
export async function handleEditBranchRatingChoice(ctx: Context, dept: string, score: number): Promise<void> {
  const reviewId = ctx.session.editingReviewId;
  if (!reviewId || ctx.session.editSavedStep !== "branch_ratings") return;
  const newBranch = ctx.session.editSavedBranchNewBranch;
  if (!newBranch) return;
  const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
  if (!row || row.telegramUserId !== ctx.from?.id) {
    await ctx.answerCallbackQuery({ text: "Отзыв не найден." });
    return;
  }
  const depts = getDepartmentsForBranch(newBranch as BranchId);
  const ratings = ctx.session.editSavedBranchRatings ?? {};
  ratings[dept] = score;
  ctx.session.editSavedBranchRatings = ratings;
  const idx = ctx.session.editSavedRatingDeptIndex ?? 0;
  const nextIdx = idx + 1;
  if (nextIdx < depts.length) {
    ctx.session.editSavedRatingDeptIndex = nextIdx;
    const nextDept = depts[nextIdx];
    const label = DEPARTMENT_LABELS[nextDept as Department];
    const ratingKb = new InlineKeyboard();
    ratingKb.row(
      { text: "1", callback_data: `edit_branch_rating:${nextDept}:1` },
      { text: "2", callback_data: `edit_branch_rating:${nextDept}:2` },
      { text: "3", callback_data: `edit_branch_rating:${nextDept}:3` },
      { text: "4", callback_data: `edit_branch_rating:${nextDept}:4` },
      { text: "5", callback_data: `edit_branch_rating:${nextDept}:5` }
    );
    ratingKb.row({ text: "◀️ Назад", callback_data: "edit_saved:back_to_what" });
    await ctx.answerCallbackQuery();
    try {
      const msg = ctx.callbackQuery?.message;
      if (msg && "message_id" in msg && msg.chat?.id) {
        await ctx.api.editMessageText(
          msg.chat.id,
          msg.message_id,
          `Оценка: ${label} (1–5)`,
          { reply_markup: ratingKb }
        );
      }
    } catch {
      await ctx.reply(`Оценка: ${label} (1–5)`, { reply_markup: ratingKb });
    }
    return;
  }
  const sumRatings = (depts as Department[]).reduce((s: number, d: Department) => s + (ratings[d] ?? 0), 0);
  const ratingOverall = Math.round(sumRatings / depts.length);
  const sections = parseCommentSections(row.comment);
  const newComment = rebuildCommentForBranch(
    sections,
    newBranch as BranchId,
    ratings as Record<Department, number>
  );
  const updates: Partial<typeof row> = {
    branch: newBranch,
    ratingKitchen: depts.includes("kitchen") ? (ratings.kitchen ?? null) : null,
    ratingBar: ratings.bar ?? 0,
    ratingHookah: depts.includes("hookah") ? (ratings.hookah ?? null) : null,
    ratingService: ratings.service ?? 0,
    ratingOverall,
    comment: newComment,
    updatedAt: new Date(),
    status: "edited",
  };
  await db.update(reviews).set(updates).where(eq(reviews.id, reviewId));
  const [updatedRow] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
  if (row.sheetsRowId && updatedRow) {
    try {
      await updateReviewInSheets(updatedRow as never, row.sheetsRowId);
    } catch {
      // queue
    }
  }
  delete ctx.session.editSavedStep;
  delete ctx.session.editSavedBranchNewBranch;
  delete ctx.session.editSavedBranchRatings;
  delete ctx.session.editSavedRatingDeptIndex;
  await ctx.answerCallbackQuery({ text: "Заведение и оценки обновлены." });
  await ctx.reply("✅ Заведение и оценки обновлены.", {
    reply_markup: getEditWhatKeyboard("edit_saved:"),
  });
}
