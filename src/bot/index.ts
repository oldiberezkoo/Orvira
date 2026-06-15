import { Bot, session } from "grammy";
import { conversations, createConversation } from "@grammyjs/conversations";
import { createSessionStorage } from "../session/storage.js";
import { conversationStorage } from "../session/conversation-storage.js";
import type { Context } from "./context.js";
import { config } from "../config.js";
import { reviewConversation } from "../handlers/review-flow.js";
import {
  handleStart,
  handleMyReviews,
  handleHelp,
  handleReviewDetail,
  handleSettings,
  handleSettingsChangeNameStart,
  handleSettingsNameCancel,
  handleChangeNameMessage,
  getStartKeyboard,
} from "../handlers/start.js";
import {
  handleReviewEditStart,
  handleReviewEditMessage,
  handleEditSavedComment,
  handleEditCommentCancel,
  handleEditCommentType,
  handleEditCommentAction,
  handleEditSavedBack,
  handleEditSavedBackToWhat,
  handleEditSavedDate,
  handleEditDateChoice,
  handleEditSavedTags,
  handleEditTagsCallback,
  handleEditSavedRatings,
  handleEditRatingChooseDept,
  handleEditSavedRatingsBack,
  handleEditRatingChoice,
  handleEditSavedPhotos,
  handleEditSavedPhotosAdd,
  handleEditSavedPhotosAddMessage,
  handleEditPhotosAddDone,
  handleEditPhotosAddCancel,
  handleEditSavedPhotosRemove,
  handleEditSavedPhotosChange,
  handleEditSavedPhotosBack,
  handleEditSavedPhotosBackFromOne,
  handleEditPhotoDelete,
  handleEditPhotoIndex,
  handleEditSavedBranch,
  handleEditBranchChoice,
  handleEditBranchRatingChoice,
} from "../handlers/edit-review.js";
import {
  handleAdminMenu,
  handleAdminExport,
  handleAdminLast,
  handleAdminBranches,
  handleAdminStats,
} from "../handlers/admin.js";

const storage = createSessionStorage();

export const bot = new Bot<Context>(config.botToken);

bot.use(
  session({
    initial: () => ({}),
    storage,
  })
);

// Сброс уровня напоминания при активности пользователя
bot.use(async (ctx, next) => {
  if (ctx.session?.draft?.reminderLevel) {
    ctx.session.draft.reminderLevel = 0;
  }
  await next();
});

bot.use(conversations({ storage: conversationStorage as never }));
bot.use(createConversation(reviewConversation as any, "review"));

bot.command("start", handleStart);

bot.callbackQuery("menu:review", async (ctx) => {
  await ctx.answerCallbackQuery();
  // Сбрасываем предыдущее состояние конверсации, чтобы избежать "Bad replay" при новом входе
  await ctx.conversation.exit("review");
  await ctx.conversation.enter("review");
});

bot.callbackQuery("menu:my_reviews", async (ctx) => {
  await ctx.answerCallbackQuery();
  await handleMyReviews(ctx as Context);
});

bot.callbackQuery("menu:settings", async (ctx) => {
  await ctx.answerCallbackQuery();
  await handleSettings(ctx as Context);
});

bot.callbackQuery("settings:change_name", async (ctx) => {
  await handleSettingsChangeNameStart(ctx as Context);
});

bot.callbackQuery("settings:name_cancel", async (ctx) => {
  await handleSettingsNameCancel(ctx as Context);
});

bot.callbackQuery("menu:admin", async (ctx) => {
  await ctx.answerCallbackQuery();
  await handleAdminMenu(ctx as Context);
});

bot.callbackQuery("admin:export", async (ctx) => {
  await ctx.answerCallbackQuery();
  await handleAdminExport(ctx as Context);
});

bot.callbackQuery("admin:last", async (ctx) => {
  await ctx.answerCallbackQuery();
  await handleAdminLast(ctx as Context, 5);
});

bot.callbackQuery("admin:branches", async (ctx) => {
  await ctx.answerCallbackQuery();
  await handleAdminBranches(ctx as Context);
});

bot.callbackQuery("menu:back", async (ctx) => {
  await ctx.answerCallbackQuery();
  const keyboard = await getStartKeyboard(ctx as Context);
  await ctx.reply("Выберите действие:", { reply_markup: keyboard });
});

bot.callbackQuery("menu:help", async (ctx) => {
  await ctx.answerCallbackQuery();
  await handleHelp(ctx as Context);
});

bot.callbackQuery(/^review_detail:(.+)$/, async (ctx) => {
  const reviewId = ctx.match[1];
  await handleReviewDetail(ctx as Context, reviewId);
});

bot.callbackQuery(/^review_edit:(.+)$/, async (ctx) => {
  const reviewId = ctx.match[1];
  await handleReviewEditStart(ctx as Context, reviewId);
});

bot.callbackQuery("edit_saved:comment", (ctx) => handleEditSavedComment(ctx as Context));
bot.callbackQuery("edit_comment:cancel", (ctx) => handleEditCommentCancel(ctx as Context));
bot.callbackQuery(/^edit_comment_type:(.+)$/, (ctx) => handleEditCommentType(ctx as Context, ctx.match[1]));
bot.callbackQuery(/^edit_comment_action:(back|delete|edit)$/, (ctx) =>
  handleEditCommentAction(ctx as Context, ctx.match[1] as "back" | "delete" | "edit")
);
bot.callbackQuery("edit_saved:back", (ctx) => handleEditSavedBack(ctx as Context));
bot.callbackQuery("edit_saved:back_to_review", (ctx) => handleEditSavedBack(ctx as Context));
bot.callbackQuery("edit_saved:back_to_what", (ctx) => handleEditSavedBackToWhat(ctx as Context));
bot.callbackQuery("edit_saved:date", (ctx) => handleEditSavedDate(ctx as Context));
bot.callbackQuery(/^edit_date:(today|yesterday|day_before)$/, (ctx) =>
  handleEditDateChoice(ctx as Context, ctx.match[1] as "today" | "yesterday" | "day_before")
);
bot.callbackQuery("edit_saved:tags", (ctx) => handleEditSavedTags(ctx as Context));
bot.callbackQuery(/^edit_tags:(.+)$/, (ctx) => handleEditTagsCallback(ctx as Context, ctx.callbackQuery.data));
bot.callbackQuery("edit_saved:ratings", (ctx) => handleEditSavedRatings(ctx as Context));
bot.callbackQuery("edit_saved:ratings_back", (ctx) => handleEditSavedRatingsBack(ctx as Context));
bot.callbackQuery(/^edit_rating_choose:(kitchen|bar|hookah|service)$/, (ctx) =>
  handleEditRatingChooseDept(ctx as Context, ctx.match[1])
);
bot.callbackQuery(/^edit_rating:(kitchen|bar|hookah|service):(\d)$/, (ctx) =>
  handleEditRatingChoice(ctx as Context, ctx.match[1], parseInt(ctx.match[2], 10))
);
bot.callbackQuery("edit_saved:photos", (ctx) => handleEditSavedPhotos(ctx as Context));
bot.callbackQuery("edit_saved:photos_add", (ctx) => handleEditSavedPhotosAdd(ctx as Context));
bot.callbackQuery("edit_photos_add:done", (ctx) => handleEditPhotosAddDone(ctx as Context));
bot.callbackQuery("edit_photos_add:cancel", (ctx) => handleEditPhotosAddCancel(ctx as Context));
bot.callbackQuery("edit_saved:photos_remove", (ctx) => handleEditSavedPhotosRemove(ctx as Context));
bot.callbackQuery("edit_saved:photos_change", (ctx) => handleEditSavedPhotosChange(ctx as Context));
bot.callbackQuery("edit_saved:photos_back", (ctx) => handleEditSavedPhotosBack(ctx as Context));
bot.callbackQuery("edit_saved:photos_back_from_one", (ctx) => handleEditSavedPhotosBackFromOne(ctx as Context));
bot.callbackQuery("edit_saved:branch", (ctx) => handleEditSavedBranch(ctx as Context));
bot.callbackQuery(/^edit_branch:(.+)$/, (ctx) => handleEditBranchChoice(ctx as Context, ctx.match[1]));
bot.callbackQuery(/^edit_branch_rating:(kitchen|bar|hookah|service):(\d)$/, (ctx) =>
  handleEditBranchRatingChoice(ctx as Context, ctx.match[1], parseInt(ctx.match[2], 10))
);
bot.callbackQuery("edit_saved:start_over", (ctx) => handleEditSavedBack(ctx as Context));

bot.callbackQuery(/^edit_photo_del:(.+):(\d+)$/, async (ctx) => {
  const [, reviewId, indexStr] = ctx.match;
  if (reviewId && indexStr != null) await handleEditPhotoDelete(ctx as Context, reviewId, indexStr);
});

bot.callbackQuery(/^edit_photo_idx:(.+):(\d+)$/, async (ctx) => {
  const [, reviewId, indexStr] = ctx.match;
  if (reviewId && indexStr != null) await handleEditPhotoIndex(ctx as Context, reviewId, indexStr);
});

bot.on("message:text", async (ctx, next) => {
  let handled = await handleReviewEditMessage(ctx as Context);
  if (!handled) handled = await handleChangeNameMessage(ctx as Context);
  if (!handled) await next();
});

bot.on("message:photo", async (ctx, next) => {
  const handled = await handleEditSavedPhotosAddMessage(ctx as Context);
  if (!handled) await next();
});

bot.command("my_reviews", handleMyReviews);
bot.command("help", handleHelp);

bot.command("admin", handleAdminMenu);
bot.command("export", handleAdminExport);
bot.command("last", (ctx) => handleAdminLast(ctx as Context));
bot.command("stats", handleAdminStats);

bot.catch((err) => {
  console.error("Bot error:", err);
});
