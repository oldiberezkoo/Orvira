import type { BranchId } from "../db/schema.js";
import type { Department } from "../lib/branches.js";

export type ReviewStep =
  | "guest_name"
  | "visit_date"
  | "branch"
  | "dish_name"
  | "comment"
  | "ratings"
  | "tags"
  | "photos"
  | "confirm";

export interface DraftReview {
  guestName?: string;
  visitDate?: Date;
  branch?: BranchId;
  dishName?: string;
  comment?: string;
  ratings?: Partial<Record<Department, number>>;
  tags?: string[];
  photoFileIds?: string[];
  step?: ReviewStep;
  /** Уровень напоминания: 0=нет, 1=30мин, 2=1ч, 3=2ч */
  reminderLevel?: number;
  /** ID последнего отправленного напоминания (чтобы удалять перед новым) */
  lastReminderMessageId?: number;
  /** ID сообщений (Check data, Confirm, MediaGroup) для удаления при отправке */
  confirmMessageIds?: number[];
}

/** Шаг при редактировании сохранённого отзыва */
export type EditSavedStep =
  | "what"
  | "comment"
  | "comment_type"
  | "comment_show"
  | "date"
  | "tags"
  | "ratings_choose_dept"
  | "ratings"
  | "branch_choose"
  | "branch_ratings"
  | "photos_action"
  | "photos_remove_one"
  | "photos_add";

export interface SessionData {
  draft?: DraftReview;
  editingReviewId?: string;
  /** Шаг при редактировании отзыва (меню «Что изменить?» и далее) */
  editSavedStep?: EditSavedStep;
  /** Какой тип комментария меняем: general | kitchen | bar | hookah | service */
  editCommentType?: string;
  /** Сообщение «Введите комментарий» — для удаления при отмене */
  editCommentPromptRef?: { chatId: number; messageId: number };
  /** Выбранные теги при редактировании тегов */
  editSavedTagsSelection?: string[];
  /** Текущая страница тегов при редактировании */
  editSavedTagsPage?: number;
  /** Индекс цеха при редактировании оценок (0, 1, …) */
  editSavedRatingDeptIndex?: number;
  /** Выбранный цех для смены одной оценки (режим «какую оценку поменять») */
  editSavedRatingDept?: string;
  /** Смена заведения: новый branch при пошаговом сборе оценок */
  editSavedBranchNewBranch?: string;
  /** Оценки по цехам при смене заведения (накапливаются по шагам) */
  editSavedBranchRatings?: Record<string, number>;
  /** Временные file_id при добавлении фото к отзыву */
  editSavedNewPhotoIds?: string[];
  /** Индекс фото при удалении по одному (edit_saved:photos → Изменить) */
  editPhotoIndex?: number;
  changingName?: boolean;
  /** Сообщение «Текущее имя» в настройках — для удаления при отмене смены имени */
  settingsMenuRef?: { chatId: number; messageId: number };
}
