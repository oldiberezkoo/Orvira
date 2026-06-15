import { InlineKeyboard } from "grammy";
import type { Context } from "../bot/context.js";
import { db } from "../db/index.js";
import { reviews } from "../db/schema.js";
import { eq, desc } from "drizzle-orm";
import { rowToReview } from "../db/review-mapper.js";
import { BRANCH_CONFIG } from "../lib/branches.js";
import { formatTags } from "../lib/tags.js";
import { config, isAdmin } from "../config.js";
import { recordChatId } from "../services/chat-ids.js";

const MENU_ROWS_BASE: [string, string][] = [
  ["✅ Оставить отзыв", "menu:review"],
  ["📄 Мои отзывы", "menu:my_reviews"],
  ["⚙️ Настройки", "menu:settings"],
  ["ℹ️ Помощь", "menu:help"],
];

export const MENU_KEYBOARD = new InlineKeyboard(MENU_ROWS_BASE.map(([text, data]) => [{ text, callback_data: data }]));

/** Клавиатура главного меню. Настройки показываем только если у пользователя уже задано имя. */
export async function getStartKeyboard(ctx: Context): Promise<InlineKeyboard> {
  const rows: [string, string][] = [
    ["✅ Оставить отзыв", "menu:review"],
    ["📄 Мои отзывы", "menu:my_reviews"],
  ];
  if (ctx.from?.id) {
    const { getUserName } = await import("../services/users.js");
    const name = await getUserName(ctx.from.id);
    if (name) rows.push(["⚙️ Настройки", "menu:settings"]);
  }
  rows.push(["ℹ️ Помощь", "menu:help"]);
  const k = new InlineKeyboard(rows.map(([text, data]) => [{ text, callback_data: data }]));
  if (ctx.from?.id && isAdmin(ctx.from.id)) {
    k.row({ text: "👑 Команды админа", callback_data: "menu:admin" });
  }
  return k;
}

const FIRST_START_GREETING =
  "🍃 Дорогие, гости! 🍃\n\n" +
  "Здесь вы можете оставить отзыв о посещении наших заведений — мы будем рады узнать ваше мнение о кухне, сервисе и атмосфере. " +
  "Ваши отзывы помогают нам становиться лучше.\n\n" +
  "Выберите действие в меню ниже:";

export async function handleStart(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  let isFirstStart = false;
  if (chatId) {
    try {
      isFirstStart = await recordChatId(chatId);
    } catch (err) {
      console.error("recordChatId failed:", err);
    }
  }
  const keyboard = await getStartKeyboard(ctx);
  if (isFirstStart) {
    await ctx.reply(FIRST_START_GREETING, { reply_markup: keyboard });
  } else {
    await ctx.reply("Выберите действие:", { reply_markup: keyboard });
  }
}

const SETTINGS_CANCEL_KEYBOARD = new InlineKeyboard([[{ text: "Отменить", callback_data: "settings:name_cancel" }]]);

export async function handleSettings(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;
  const { getUserName } = await import("../services/users.js");
  const name = await getUserName(userId);
  const keyboard = new InlineKeyboard([
    [{ text: "Изменить имя", callback_data: "settings:change_name" }],
    [{ text: "Назад", callback_data: "menu:back" }],
  ]);
  const msg = await ctx.reply(
    name ? `Текущее имя: ${name}. Нажмите «Изменить имя», чтобы изменить.` : "Сохраните имя — оно будет подставляться в новые отзывы.",
    { reply_markup: keyboard }
  );
  ctx.session.settingsMenuRef = { chatId: msg.chat.id, messageId: msg.message_id };
}

export async function handleSettingsChangeNameStart(ctx: Context): Promise<void> {
  ctx.session.changingName = true;
  await ctx.answerCallbackQuery();
  await ctx.reply("Введите новое имя и фамилию (минимум 2 слова, только буквы):", {
    reply_markup: SETTINGS_CANCEL_KEYBOARD,
  });
}

/** Отмена смены имени: удаляем сообщения «Текущее имя» и «Введите новое имя», показываем меню без «Отменено». */
export async function handleSettingsNameCancel(ctx: Context): Promise<void> {
  delete ctx.session.changingName;
  await ctx.answerCallbackQuery();
  const promptMsg = ctx.callbackQuery?.message;
  if (promptMsg && "message_id" in promptMsg && promptMsg.chat?.id) {
    try {
      await ctx.api.deleteMessage(promptMsg.chat.id, promptMsg.message_id);
    } catch {
      // ignore
    }
  }
  const ref = ctx.session.settingsMenuRef;
  if (ref) {
    try {
      await ctx.api.deleteMessage(ref.chatId, ref.messageId);
    } catch {
      // ignore
    }
    delete ctx.session.settingsMenuRef;
  }
  const keyboard = await getStartKeyboard(ctx);
  await ctx.reply("Выберите действие:", { reply_markup: keyboard });
}

export async function handleChangeNameMessage(ctx: Context): Promise<boolean> {
  if (!ctx.session.changingName) return false;
  const text = ctx.message?.text?.trim();
  if (!text) {
    await ctx.reply("Введите имя и фамилию.");
    return true;
  }
  const { guestNameSchema } = await import("../lib/validation.js");
  const { updateUserName } = await import("../services/users.js");
  const result = guestNameSchema.safeParse(text);
  if (!result.success) {
    await ctx.reply(result.error.errors[0]?.message ?? "Введите имя и фамилию (минимум 2 слова, только буквы).");
    return true;
  }
  const userId = ctx.from?.id;
  if (!userId) return false;
  await updateUserName(userId, result.data);
  delete ctx.session.changingName;
  await ctx.reply("✅ Имя сохранено.");
  return true;
}

export async function handleMyReviews(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;
  const list = await db
    .select()
    .from(reviews)
    .where(eq(reviews.telegramUserId, userId))
    .orderBy(desc(reviews.createdAt))
    .limit(100);
  if (list.length === 0) {
    const keyboard = await getStartKeyboard(ctx);
    await ctx.reply("У вас пока нет отзывов.", { reply_markup: keyboard });
    return;
  }
  const lines = list.map((r, i) => {
    const branchLabel = BRANCH_CONFIG[r.branch as keyof typeof BRANCH_CONFIG].label;
    return `${i + 1}. ${r.visitDate.toLocaleDateString("ru-RU")} — ${branchLabel}, «${r.dishName}», ${r.ratingOverall}/5`;
  });
  const keyboard = new InlineKeyboard(
    list.map((r) => [{ text: `Отзыв ${r.id.slice(0, 8)}…`, callback_data: `review_detail:${r.id}` }])
  );
  keyboard.row({ text: "◀️ Вернуться к меню", callback_data: "menu:back" });
  await ctx.reply("Мои отзывы\n\n" + lines.join("\n"), {
    reply_markup: keyboard,
  });
}

export async function handleHelp(ctx: Context): Promise<void> {
  const keyboard = new InlineKeyboard().row({ text: "◀️ Вернуться к меню", callback_data: "menu:back" });
  await ctx.reply(
    "Бот для сбора отзывов.\n\n" +
      "• Оставить отзыв — пошагово заполните данные о визите, блюде, рейтингах по цехам и при желании приложите фото.\n" +
      "• Мои отзывы — просмотр и (в течение 24 ч) редактирование ваших отзывов.\n\n" +
      "Команды: /start — меню, /my_reviews — мои отзывы, /help — эта справка.",
    { reply_markup: keyboard }
  );
}

export async function handleReviewDetail(ctx: Context, reviewId: string): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;
  const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
  if (!row || row.telegramUserId !== userId) {
    await ctx.answerCallbackQuery({ text: "Отзыв не найден." });
    return;
  }
  const review = rowToReview(row);
  const branchLabel = BRANCH_CONFIG[review.branch].label;
  const canEdit =
    (Date.now() - review.createdAt.getTime()) / (1000 * 60 * 60) < config.editWindowHours;
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
  if (canEdit) {
    keyboard.add({ text: "Изменить", callback_data: `review_edit:${reviewId}` });
  }
  keyboard.add({ text: "Назад к списку", callback_data: "menu:my_reviews" });
  await ctx.answerCallbackQuery();
  await ctx.reply(lines.join("\n"), { reply_markup: keyboard });
}
