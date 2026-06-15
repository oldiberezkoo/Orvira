import { Conversation } from "@grammyjs/conversations";
import { InlineKeyboard } from "grammy";
import type { Context } from "../bot/context.js";
import type { BranchId } from "../db/schema.js";
import { BRANCHES } from "../db/schema.js";
import { getStartKeyboard } from "../handlers/start.js";
import type { Department } from "../lib/branches.js";
import {
  BRANCH_CONFIG,
  DEPARTMENT_LABELS,
  getDepartmentsForBranch,
} from "../lib/branches.js";
import { formatTags, PROBLEM_TAGS } from "../lib/tags.js";
import {
  branchSchema,
  commentSchema,
  departmentCommentSchema,
  dishNameSchema,
  guestNameSchema,
  parseVisitDate,
  PHOTO_MAX_COUNT,
  ratingSchema,
  visitDateSchema,
} from "../lib/validation.js";
import { saveReviewFromDraft } from "../services/save-review.js";
import { getUserName, updateUserName } from "../services/users.js";
import type { DraftReview } from "../session/types.js";
import { saveDraft } from "../services/drafts.js";

function getBranchKeyboard() {
  const k = new InlineKeyboard(
    BRANCHES.map((b) => [
      { text: BRANCH_CONFIG[b].label, callback_data: `branch:${b}` },
    ])
  );
  k.row({ text: "Отменить", callback_data: "review:cancel" });
  return k;
}

const TAGS_PAGE_SIZE = 3;

const CANCEL_REVIEW = "CANCEL_REVIEW";
const BACK_TO_EDIT_MENU = "BACK_TO_EDIT_MENU";

function getCancelReviewKeyboard() {
  return new InlineKeyboard([[{ text: "Отменить", callback_data: "review:cancel" }]]);
}

/** Кнопки 1 2 3 4 5 в один ряд; для кальяна — дополнительно «Пропустить». */
function getRatingKeyboard(dept: Department) {
  const row = [1, 2, 3, 4, 5].map((i) => ({
    text: String(i),
    callback_data: `rate:${dept}:${i}`,
  }));
  const k = new InlineKeyboard([row]);
  if (dept === "hookah") {
    k.row({ text: "Пропустить", callback_data: "rate:hookah:skip" });
  }
  return k;
}

/** Теги по 3 на странице; выбранные с галочкой (✔️). */
function getTagsKeyboard(selected: string[], page: number) {
  const from = page * TAGS_PAGE_SIZE;
  const slice = PROBLEM_TAGS.slice(from, from + TAGS_PAGE_SIZE);
  const k = new InlineKeyboard();
  for (const t of slice) {
    const mark = selected.includes(t.id) ? " ✔️" : "";
    k.add({ text: t.shortLabel + mark, callback_data: `tag:${t.id}` });
  }
  const nav: { text: string; callback_data: string }[] = [];
  if (page > 0)
    nav.push({ text: "◀️ Назад", callback_data: `tags:page:${page - 1}` });
  if (from + TAGS_PAGE_SIZE < PROBLEM_TAGS.length)
    nav.push({ text: "Вперёд ▶️", callback_data: `tags:page:${page + 1}` });
  if (nav.length) k.row(...nav);
  k.row(
    { text: "Пропустить", callback_data: "tags:skip" },
    { text: "Готово", callback_data: "tags:done" }
  );
  return k;
}

function getConfirmKeyboard() {
  return new InlineKeyboard([
    [
      { text: "Отправить", callback_data: "confirm:send" },
      { text: "Изменить", callback_data: "confirm:edit" },
      { text: "Отмена", callback_data: "confirm:cancel" },
    ],
  ]);
}

export function getEditWhatKeyboard(prefix: "edit:" | "edit_saved:" = "edit:") {
  return new InlineKeyboard([
    [
      { text: "Заведение", callback_data: `${prefix}branch` },
      { text: "Оценки", callback_data: `${prefix}ratings` },
    ],
    [
      { text: "Комментарий", callback_data: `${prefix}comment` },
      { text: "Теги", callback_data: `${prefix}tags` },
    ],
    [
      { text: "Фото", callback_data: `${prefix}photos` },
      { text: "Дата", callback_data: `${prefix}date` },
    ],
    [
      { text: "Заново", callback_data: `${prefix}start_over` },
      { text: "Назад", callback_data: `${prefix}back` },
    ],
  ]);
}

function buildPreview(draft: DraftReview): string {
  const depts = draft.branch ? getDepartmentsForBranch(draft.branch) : [];
  const definedDepts = depts.filter((d) => draft.ratings?.[d] != null);
  const overall =
    definedDepts.length > 0
      ? Math.round(
          definedDepts.reduce((s, d) => s + (draft.ratings![d] ?? 0), 0) /
            definedDepts.length
        )
      : 0;
  return [
    `👤 ${draft.guestName}`,
    `📅 ${draft.visitDate!.toLocaleDateString("ru-RU")}`,
    `🏢 ${BRANCH_CONFIG[draft.branch! as keyof typeof BRANCH_CONFIG].label}`,
    `🍽️ ${draft.dishName}`,
    `💬 ${draft.comment!.slice(0, 200)}${
      draft.comment!.length > 200 ? "…" : ""
    }`,
    `⭐ Общий рейтинг: ${overall}/5`,
    `🏷️ ${draft.tags!.length ? formatTags(draft.tags!) : "—"}`,
    `📷 Фото: ${draft.photoFileIds?.length ?? 0} шт.`,
  ].join("\n");
}

// Вспомогательные функции для избежания дублирования кода

async function collectDate(
  conversation: Conversation<Context>,
  ctx: Context,
  options?: { showBackButton?: boolean }
): Promise<Date> {
  const showBack = options?.showBackButton ?? false;
  while (true) {
    const dateKb = new InlineKeyboard([
      [
        { text: "Сегодня", callback_data: "visit:today" },
        { text: "Вчера", callback_data: "visit:yesterday" },
        { text: "Послевчера", callback_data: "visit:day_before" },
      ],
    ]);
    if (showBack) dateKb.row({ text: "◀️ Назад", callback_data: "visit:back" });
    dateKb.row({ text: "Отменить", callback_data: "review:cancel" });
    await ctx.reply("Дата визита: кнопка или ДД.ММ.ГГГГ", {
      reply_markup: dateKb,
    });
    const dateCtx = await conversation.wait();
    if (dateCtx.callbackQuery?.data === "review:cancel") {
      await dateCtx.answerCallbackQuery();
      throw new Error(CANCEL_REVIEW);
    }
    if (dateCtx.callbackQuery?.data === "visit:back") {
      await dateCtx.answerCallbackQuery();
      throw new Error(BACK_TO_EDIT_MENU);
    }
    let dateInput: string;
    if (dateCtx.callbackQuery?.data === "visit:today") {
      dateInput = "Сегодня";
      await dateCtx.answerCallbackQuery();
    } else if (dateCtx.callbackQuery?.data === "visit:yesterday") {
      dateInput = "Вчера";
      await dateCtx.answerCallbackQuery();
    } else if (dateCtx.callbackQuery?.data === "visit:day_before") {
      dateInput = "Послевчера";
      await dateCtx.answerCallbackQuery();
    } else if (dateCtx.callbackQuery) {
      await dateCtx.answerCallbackQuery({ text: "Выберите кнопку или введите дату ДД.ММ.ГГГГ" }).catch(() => {});
      continue;
    } else {
      dateInput = dateCtx.message?.text?.trim() ?? "";
    }
    const dateResult = visitDateSchema.safeParse(dateInput);
    if (!dateResult.success) {
      await ctx.reply(
        dateResult.error.errors[0]?.message ?? "Неверный формат даты."
      );
      continue;
    }
    try {
      const dateVal = await conversation.external(() =>
        parseVisitDate(dateResult.data)
      );
      return typeof dateVal === "string" ? new Date(dateVal) : dateVal;
    } catch {
      await ctx.reply("Некорректная дата. Введите снова.");
      continue;
    }
  }
}

/** Необязательный комментарий к цеху: текст или «Пропустить». Одно сообщение при лимите — без повторного запроса. */
async function collectDepartmentComment(
  conversation: Conversation<Context>,
  ctx: Context,
  dept: Department
): Promise<string> {
  const label = DEPARTMENT_LABELS[dept];
  const skipKb = new InlineKeyboard().row(
    { text: "Пропустить", callback_data: "dept_comment:skip" },
    { text: "Отменить", callback_data: "review:cancel" }
  );
  await ctx.reply(`Комментарий к «${label}» (необязательно):`, {
    reply_markup: skipKb,
  });
  while (true) {
    const commentCtx = await conversation.wait();
    if (commentCtx.callbackQuery?.data === "review:cancel") {
      await commentCtx.answerCallbackQuery();
      throw new Error(CANCEL_REVIEW);
    }
    if (commentCtx.callbackQuery?.data === "dept_comment:skip") {
      await commentCtx.answerCallbackQuery();
      return "";
    }
    const text = commentCtx.message?.text?.trim() ?? "";
    if (commentCtx.callbackQuery) {
      await commentCtx.answerCallbackQuery({ text: "Введите комментарий текстом или нажмите «Пропустить»" }).catch(() => {});
      continue;
    }
    if (!text) return "";
    const result = departmentCommentSchema.safeParse(text);
    if (!result.success) {
      await ctx.reply("Максимум 1000 символов.", { reply_markup: skipKb });
      continue;
    }
    return result.data;
  }
}

/** Собирает комментарии по каждому цеху, затем общий комментарий. Возвращает итоговую строку для draft.comment. */
async function collectCommentsWithDepartments(
  conversation: Conversation<Context>,
  ctx: Context,
  branch: BranchId,
  ratings: Partial<Record<Department, number>>
): Promise<string> {
  const depts = getDepartmentsForBranch(branch);
  const parts: string[] = [];
  for (const dept of depts) {
    const label = DEPARTMENT_LABELS[dept];
    const rateStr = ratings[dept] != null ? String(ratings[dept]) : "—";
    const comment = await collectDepartmentComment(conversation, ctx, dept);
    if (comment) {
      parts.push(`${label} (${rateStr}): ${comment}`);
    }
  }
  await ctx.reply("Общий комментарий к отзыву (10–1000 символов):", {
    reply_markup: getCancelReviewKeyboard(),
  });
  while (true) {
    const commentCtx = await conversation.wait();
    if (commentCtx.callbackQuery?.data === "review:cancel") {
      await commentCtx.answerCallbackQuery();
      throw new Error(CANCEL_REVIEW);
    }
    const commentText = commentCtx.message?.text?.trim();
    if (commentCtx.callbackQuery) {
      await commentCtx.answerCallbackQuery({ text: "Введите общий комментарий текстом" }).catch(() => {});
      continue;
    }
    if (!commentText) {
      await ctx.reply("Нужен текстовый ввод (минимум 10 символов).");
      continue;
    }
    const commentResult = commentSchema.safeParse(commentText);
    if (!commentResult.success) {
      await ctx.reply(
        commentResult.error.errors[0]?.message ?? "Минимум 10 символов.",
        { reply_markup: getCancelReviewKeyboard() }
      );
      continue;
    }
    const general = commentResult.data;
    if (parts.length > 0) {
      parts.push(`Общий: ${general}`);
      return parts.join("\n");
    }
    return general;
  }
}

/** Только общий комментарий (для редактирования в подтверждении). */
async function collectGeneralCommentOnly(
  conversation: Conversation<Context>,
  ctx: Context
): Promise<string> {
  await ctx.reply("Общий комментарий к отзыву (10–1000 символов):", {
    reply_markup: getCancelReviewKeyboard(),
  });
  while (true) {
    const commentCtx = await conversation.wait();
    if (commentCtx.callbackQuery?.data === "review:cancel") {
      await commentCtx.answerCallbackQuery();
      throw new Error(CANCEL_REVIEW);
    }
    const commentText = commentCtx.message?.text?.trim();
    if (commentCtx.callbackQuery) {
      await commentCtx.answerCallbackQuery({ text: "Введите комментарий текстом" }).catch(() => {});
      continue;
    }
    if (!commentText) {
      await ctx.reply("Нужен текстовый ввод.");
      continue;
    }
    const commentResult = commentSchema.safeParse(commentText);
    if (!commentResult.success) {
      await ctx.reply(
        commentResult.error.errors[0]?.message ?? "Минимум 10 символов.",
        { reply_markup: getCancelReviewKeyboard() }
      );
      continue;
    }
    return commentResult.data;
  }
}

async function collectTags(
  conversation: Conversation<Context>,
  ctx: Context,
  initialTags: string[] = []
): Promise<string[]> {
  const tags = [...initialTags];
  let tagsPage = 0;
  const tagsKb = getTagsKeyboard(tags, tagsPage);
  tagsKb.row({ text: "Отменить", callback_data: "review:cancel" });
  await ctx.reply("Теги проблем (или Пропустить / Готово):", {
    reply_markup: tagsKb,
  });

  while (true) {
    const tagCtx = await conversation.waitFor("callback_query:data");
    const data = tagCtx.callbackQuery?.data ?? "";
    await tagCtx.answerCallbackQuery();

    if (data === "review:cancel") throw new Error(CANCEL_REVIEW);
    if (data === "tags:skip") return [];
    if (data === "tags:done") return tags;

    if (data.startsWith("tags:page:")) {
      tagsPage = Math.max(0, parseInt(data.slice(10), 10));
      const totalPages = Math.ceil(PROBLEM_TAGS.length / TAGS_PAGE_SIZE);
      tagsPage = Math.min(tagsPage, totalPages - 1);
    } else if (data.startsWith("tag:")) {
      const id = data.slice(4);
      const idx = tags.indexOf(id);
      if (idx !== -1) {
        tags.splice(idx, 1);
      } else {
        tags.push(id);
      }
    }

    const msg = tagCtx.callbackQuery?.message;
    const nextTagsKb = getTagsKeyboard(tags, tagsPage);
    nextTagsKb.row({ text: "Отменить", callback_data: "review:cancel" });
    if (msg && "message_id" in msg && msg.chat?.id) {
      try {
        await tagCtx.api.editMessageText(
          msg.chat.id,
          msg.message_id,
          "Теги проблем (или Пропустить / Готово):",
          { reply_markup: nextTagsKb }
        );
      } catch {
        await ctx.reply("Теги (ещё или Готово):", {
          reply_markup: nextTagsKb,
        });
      }
    }
  }
}

function getPhotosKeyboard(): InlineKeyboard {
  return new InlineKeyboard([
    [
      { text: "Готово", callback_data: "photos:done" },
      { text: "Пропустить", callback_data: "photos:skip" },
    ],
    [{ text: "Отменить", callback_data: "review:cancel" }],
  ]);
}

/** Клавиатура при достижении лимита фото: Готово, Пропустить, Отменить, Заново. */
function getPhotosOverflowKeyboard(): InlineKeyboard {
  return new InlineKeyboard([
    [
      { text: "Готово", callback_data: "photos:done" },
      { text: "Пропустить", callback_data: "photos:skip" },
    ],
    [
      { text: "Отменить", callback_data: "review:cancel" },
      { text: "Заново", callback_data: "photos:restart" },
    ],
  ]);
}

async function collectPhotos(
  conversation: Conversation<Context>,
  ctx: Context
): Promise<string[]> {
  let photoFileIds: string[] = [];
  let lastStatusMsgId: number | undefined;

  const photosDoneKb = () => getPhotosKeyboard();
  const overflowKb = () => getPhotosOverflowKeyboard();
  const initialMsg = await ctx.reply("До 10 фото. Затем нажмите «Готово» или «Пропустить».", {
    reply_markup: photosDoneKb(),
  });
  lastStatusMsgId = initialMsg.message_id;

  while (true) {
    const photoCtx = await conversation.wait();
    if (photoCtx.callbackQuery?.data === "review:cancel") {
      await photoCtx.answerCallbackQuery();
      if (lastStatusMsgId) {
        await ctx.api.deleteMessage(ctx.chat!.id, lastStatusMsgId).catch(() => {});
      }
      throw new Error(CANCEL_REVIEW);
    }
    if (photoCtx.callbackQuery?.data === "photos:done") {
      await photoCtx.answerCallbackQuery();
      if (lastStatusMsgId) {
        await ctx.api.deleteMessage(ctx.chat!.id, lastStatusMsgId).catch(() => {});
      }
      return photoFileIds;
    }
    if (photoCtx.callbackQuery?.data === "photos:skip") {
      await photoCtx.answerCallbackQuery();
      if (lastStatusMsgId) {
        await ctx.api.deleteMessage(ctx.chat!.id, lastStatusMsgId).catch(() => {});
      }
      return [];
    }
    if (photoCtx.callbackQuery?.data === "photos:restart") {
      await photoCtx.answerCallbackQuery({ text: "Начинаем загрузку фото заново." });
      photoFileIds = [];
      const msg = await ctx.reply("До 10 фото. Отправьте фото или нажмите «Готово» / «Пропустить».", {
        reply_markup: photosDoneKb(),
      });
      lastStatusMsgId = msg.message_id;
      continue;
    }

    const photo = photoCtx.message?.photo;
    if (photo?.length) {
      const fileId = photo[photo.length - 1].file_id;
      if (photoFileIds.length >= PHOTO_MAX_COUNT) {
        const text = `Максимум ${PHOTO_MAX_COUNT} фото. Нажмите «Готово», «Пропустить» или «Заново».`;
        if (lastStatusMsgId) {
          try {
            await ctx.api.deleteMessage(ctx.chat!.id, lastStatusMsgId).catch(() => {});
          } catch {}
        }
        const msg = await ctx.reply(text, { reply_markup: overflowKb() });
        lastStatusMsgId = msg.message_id;
        continue;
      }
      photoFileIds.push(fileId);
      
      const text = `📷 Фото добавлено (${photoFileIds.length} из ${PHOTO_MAX_COUNT}). Отправьте ещё или нажмите «Готово».`;
      const markup = photoFileIds.length >= PHOTO_MAX_COUNT ? overflowKb() : photosDoneKb();
      
      if (lastStatusMsgId) {
        try {
          await ctx.api.deleteMessage(ctx.chat!.id, lastStatusMsgId).catch(() => {});
        } catch {}
      }
      const msg = await ctx.reply(text, { reply_markup: markup });
      lastStatusMsgId = msg.message_id;
      continue;
    }
    
    // Если пришло не фото, а текст или другое
    const text = "Отправьте фото или нажмите «Готово» / «Пропустить».";
    if (lastStatusMsgId) {
       try {
         await ctx.api.deleteMessage(ctx.chat!.id, lastStatusMsgId).catch(() => {});
       } catch {}
    }
    const msg = await ctx.reply(text, { reply_markup: photosDoneKb() });
    lastStatusMsgId = msg.message_id;
  }
}

async function collectRatings(
  conversation: Conversation<Context>,
  ctx: Context,
  branch: BranchId
): Promise<Partial<Record<Department, number>>> {
  const ratings: Partial<Record<Department, number>> = {};
  const depts = getDepartmentsForBranch(branch);

  const ratingKbWithCancel = (dept: Department) => {
    const k = getRatingKeyboard(dept);
    k.row({ text: "Отменить", callback_data: "review:cancel" });
    return k;
  };
  for (const dept of depts) {
    const label = DEPARTMENT_LABELS[dept];
    const msg = await ctx.reply(
      `Оценка: ${label} (1–5)${dept === "hookah" ? " или «Пропустить»" : ""}`,
      { reply_markup: ratingKbWithCancel(dept) }
    );
    const rateCtx = await conversation.waitFor("callback_query:data");
    const data = rateCtx.callbackQuery?.data;

    if (data === "review:cancel") {
      await rateCtx.answerCallbackQuery();
      throw new Error(CANCEL_REVIEW);
    }
    if (dept === "hookah" && data === "rate:hookah:skip") {
      await rateCtx.answerCallbackQuery({ text: "Оценка пропущена." });
      try {
        await rateCtx.api.editMessageText(
          msg.chat.id,
          msg.message_id,
          `Оценка: ${label} —`
        );
      } catch {
        // Message might be too old to edit
      }
      continue;
    }
    if (!data?.startsWith(`rate:${dept}:`)) {
      await ctx.reply("Выберите оценку кнопкой.");
      throw new Error("Invalid rating selection");
    }

    const num = parseInt(data.split(":")[2], 10);
    const rateResult = ratingSchema.safeParse(num);
    if (!rateResult.success) {
      await ctx.reply("Оценка от 1 до 5.");
      throw new Error("Invalid rating value");
    }

    ratings[dept] = rateResult.data;
    await rateCtx.answerCallbackQuery();

    try {
      await rateCtx.api.editMessageText(
        msg.chat.id,
        msg.message_id,
        `Оценка: ${label} ${rateResult.data}`
      );
    } catch {
      // Message might be too old to edit
    }
  }

  return ratings;
}

export async function reviewConversation(
  conversation: Conversation<Context>,
  ctx: Context
): Promise<void> {
  try {
    await runReviewConversation(conversation, ctx);
  } catch (err) {
    if (err instanceof Error && err.message === CANCEL_REVIEW) {
      ctx.session.draft = undefined;
      await conversation.external(() => saveDraft(ctx.from!.id, undefined));
      await ctx.reply("Отзыв отменён.").catch(() => {});
      const keyboard = await getStartKeyboard(ctx);
      await ctx.reply("Выберите действие:", { reply_markup: keyboard }).catch(() => {});
      return;
    }
    console.error("Review conversation error:", err);
    ctx.session.draft = undefined;
    await conversation.external(() => saveDraft(ctx.from!.id, undefined));
    await ctx.reply("Произошла ошибка. Начните заново: /start").catch(() => {});
    const keyboard = await getStartKeyboard(ctx);
    await ctx.reply("Выберите действие:", { reply_markup: keyboard }).catch(() => {});
  }
}

async function runReviewConversation(
  conversation: Conversation<Context>,
  ctx: Context
): Promise<void> {
  if (!ctx.session) ctx.session = {};
  const draft = (ctx.session.draft ??= {});
  const userId = ctx.from?.id ?? 0;

  // ---- Имя: из users или запрос с валидацией в цикле ----
  const savedName = await conversation.external(() => getUserName(userId));
  if (savedName) {
    draft.guestName = savedName;
    ctx.session.draft = { ...draft }; 
    await conversation.external(() => saveDraft(userId, draft));
  } else {
    while (true) {
      await ctx.reply(
        "Введите имя и фамилию, по желанию отчество (только буквы, минимум 2 слова):",
        { reply_markup: getCancelReviewKeyboard() }
      );
      const nameCtx = await conversation.wait();
      if (nameCtx.callbackQuery?.data === "review:cancel") {
        await nameCtx.answerCallbackQuery();
        throw new Error(CANCEL_REVIEW);
      }
      const nameText = nameCtx.message?.text?.trim();
      if (nameCtx.callbackQuery) {
        await nameCtx.answerCallbackQuery({ text: "Введите имя и фамилию текстом" }).catch(() => {});
        continue;
      }
      if (!nameText) {
        await ctx.reply("Нужен текстовый ввод.");
        continue;
      }
      const nameResult = guestNameSchema.safeParse(nameText);
      if (!nameResult.success) {
        await ctx.reply(
          nameResult.error.errors[0]?.message ??
            "Введите имя и фамилию, по желанию отчество (минимум 2 слова)."
        );
        continue;
      }
      draft.guestName = nameResult.data;
      ctx.session.draft = { ...draft };
      await conversation.external(() => saveDraft(userId, draft));
      await conversation.external(() =>
        updateUserName(userId, nameResult.data)
      );
      break;
    }
  }

  // ---- Дата ----
  draft.visitDate = await collectDate(conversation, ctx);
  ctx.session.draft = { ...draft };
  await conversation.external(() => saveDraft(userId, draft));

  // ---- Филиал ----
  await ctx.reply("Выберите филиал:", { reply_markup: getBranchKeyboard() });
  const branchCtx = await conversation.waitFor("callback_query:data");
  const branchData = branchCtx.callbackQuery?.data;
  if (branchData === "review:cancel") {
    await branchCtx.answerCallbackQuery();
    throw new Error(CANCEL_REVIEW);
  }
  if (!branchData?.startsWith("branch:")) {
    await ctx.reply("Выберите филиал кнопкой.");
    return;
  }
  const branchResult = branchSchema.safeParse(branchData.slice(7));
  if (!branchResult.success) {
    await ctx.reply("Неверный филиал.");
    return;
  }
  draft.branch = branchResult.data as BranchId;
  ctx.session.draft = { ...draft };
  await conversation.external(() => saveDraft(userId, draft));
  await branchCtx.answerCallbackQuery();

  // ---- Блюдо ----
  await ctx.reply("Название блюда (3–60 символов):", {
    reply_markup: getCancelReviewKeyboard(),
  });
  while (true) {
    const dishCtx = await conversation.wait();
    if (dishCtx.callbackQuery?.data === "review:cancel") {
      await dishCtx.answerCallbackQuery();
      throw new Error(CANCEL_REVIEW);
    }
    const dishText = dishCtx.message?.text?.trim();
    if (dishCtx.callbackQuery) {
      await dishCtx.answerCallbackQuery({ text: "Введите название блюда текстом" }).catch(() => {});
      continue;
    }
    if (!dishText) {
      await ctx.reply("Нужен текстовый ввод.");
      continue;
    }
    const dishResult = dishNameSchema.safeParse(dishText);
    if (!dishResult.success) {
      await ctx.reply(
        dishResult.error.errors[0]?.message ?? "Неверный формат."
      );
      continue;
    }
    draft.dishName = dishResult.data;
    ctx.session.draft = { ...draft };
    await conversation.external(() => saveDraft(userId, draft));
    break;
  }

  // ---- Рейтинги 1–5 ----
  draft.ratings = await collectRatings(conversation, ctx, draft.branch);
  ctx.session.draft = { ...draft };
  await conversation.external(() => saveDraft(userId, draft));

  // ---- Комментарии: к каждому цеху (необязательно) и общий ----
  draft.comment = await collectCommentsWithDepartments(
    conversation,
    ctx,
    draft.branch,
    draft.ratings ?? {}
  );
  ctx.session.draft = { ...draft };
  await conversation.external(() => saveDraft(userId, draft));

  // ---- Теги ----
  draft.tags = await collectTags(conversation, ctx);
  ctx.session.draft = { ...draft };
  await conversation.external(() => saveDraft(userId, draft));

  // ---- Фото ----
  draft.photoFileIds = await collectPhotos(conversation, ctx);
  ctx.session.draft = { ...draft };
  await conversation.external(() => saveDraft(userId, draft));

  // ---- Summary + подтверждение ----
  while (true) {
    const preview = buildPreview(draft);
    const previewMsg = await ctx.reply("🍃 ~ Проверьте данные:\n\n" + preview);

    let mediaMsgs: any[] = [];
    const fileIds = draft.photoFileIds ?? [];
    if (fileIds.length > 0) {
      const media = fileIds.slice(0, 10).map((fileId: string) => ({
        type: "photo" as const,
        media: fileId,
      }));
      mediaMsgs = await ctx.replyWithMediaGroup(media).catch(() => []);
    }

    const confirmMsg = await ctx.reply("Подтвердите:", {
      reply_markup: getConfirmKeyboard(),
    });

    draft.confirmMessageIds = [
      previewMsg.message_id,
      ...mediaMsgs.map((m: any) => m.message_id),
      confirmMsg.message_id,
    ];
    ctx.session.draft = { ...draft };
    await conversation.external(() => saveDraft(userId, draft));

    const confirmCtx = await conversation.waitFor("callback_query:data");
    const action = confirmCtx.callbackQuery?.data;
    await confirmCtx.answerCallbackQuery();

    if (action === "confirm:send") {
      // Удаляем сообщения подтверждения для плавного UX
      for (const msgId of draft.confirmMessageIds || []) {
        await ctx.api.deleteMessage(ctx.chat!.id, msgId).catch(() => {});
      }
      delete draft.confirmMessageIds;
      ctx.session.draft = { ...draft };
      break;
    }

    // Если не отправка, удаляем старые сообщения подтверждения перед следующим показом или переходом к редактированию
    for (const msgId of draft.confirmMessageIds || []) {
      await ctx.api.deleteMessage(ctx.chat!.id, msgId).catch(() => {});
    }
    delete draft.confirmMessageIds;
    ctx.session.draft = { ...draft };
    await conversation.external(() => saveDraft(userId, draft));

    if (action === "confirm:cancel") {
      ctx.session.draft = undefined;
      await conversation.external(() => saveDraft(userId, undefined));
      await ctx.reply("Отзыв отменён.");
      const keyboard = await getStartKeyboard(ctx);
      await ctx.reply("Выберите действие:", { reply_markup: keyboard });
      return;
    }

    if (action === "confirm:edit") {
      await ctx.reply("Что изменить?", { reply_markup: getEditWhatKeyboard() });
      const editCtx = await conversation.waitFor("callback_query:data");
      const editAction = editCtx.callbackQuery?.data;
      await editCtx.answerCallbackQuery();

      if (editAction === "edit:back") {
        continue;
      }

      if (editAction === "edit:start_over") {
        // Начать заново - сбрасываем все данные кроме имени
        const savedGuestName = draft.guestName;
        ctx.session.draft = { guestName: savedGuestName };
        await conversation.external(() => saveDraft(userId, ctx.session.draft));
        await ctx.reply("Начинаем заново...");
        return await runReviewConversation(conversation, ctx);
      }

      if (editAction === "edit:date") {
        try {
          draft.visitDate = await collectDate(conversation, ctx, {
            showBackButton: true,
          });
          ctx.session.draft = { ...draft };
          await conversation.external(() => saveDraft(userId, draft));
        } catch (err) {
          if (err instanceof Error && err.message === BACK_TO_EDIT_MENU) {
            continue;
          }
          throw err;
        }
        continue;
      }

      if (editAction === "edit:branch") {
        await ctx.reply("Выберите филиал:", {
          reply_markup: getBranchKeyboard(),
        });
        const branchCtx2 = await conversation.waitFor("callback_query:data");
        const branchData2 = branchCtx2.callbackQuery?.data;
        await branchCtx2.answerCallbackQuery();

        if (branchData2?.startsWith("branch:")) {
          const branchResult2 = branchSchema.safeParse(branchData2.slice(7));
          if (branchResult2.success) {
            draft.branch = branchResult2.data as BranchId;
            // Пересобираем рейтинги для нового филиала
            draft.ratings = await collectRatings(
              conversation,
              ctx,
              draft.branch
            );
          }
        }
        ctx.session.draft = { ...draft };
        await conversation.external(() => saveDraft(userId, draft));
        continue;
      }

      if (editAction === "edit:ratings") {
        // Редактирование только рейтингов без смены филиала
        if (draft.branch) {
          draft.ratings = await collectRatings(conversation, ctx, draft.branch);
        }
        ctx.session.draft = { ...draft };
        await conversation.external(() => saveDraft(userId, draft));
        continue;
      }

      if (editAction === "edit:comment") {
        draft.comment = await collectGeneralCommentOnly(conversation, ctx);
        ctx.session.draft = { ...draft };
        await conversation.external(() => saveDraft(userId, draft));
        continue;
      }

      if (editAction === "edit:tags") {
        draft.tags = await collectTags(conversation, ctx, draft.tags ?? []);
        ctx.session.draft = { ...draft };
        await conversation.external(() => saveDraft(userId, draft));
        continue;
      }

      if (editAction === "edit:photos") {
        draft.photoFileIds = await collectPhotos(conversation, ctx);
        ctx.session.draft = { ...draft };
        await conversation.external(() => saveDraft(userId, draft));
        continue;
      }

      // Если действие неизвестно, продолжаем цикл
      continue;
    }

    // Если действие неизвестно
    await ctx.reply("Нажмите «Отправить», «Изменить» или «Отмена».");
  }

  // ---- Сохранение отзыва ----
  await saveReviewFromDraft(ctx, draft);
  ctx.session.draft = undefined;
  await conversation.external(() => saveDraft(userId, undefined));

  await ctx.reply(
    "🍃 ~ Благодарим вас за отзыв. Мы обязательно прислушаемся к вашему мнению."
  );
  const keyboard = await getStartKeyboard(ctx);
  await ctx.reply("Выберите действие:", { reply_markup: keyboard });
}
