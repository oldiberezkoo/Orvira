/** Фиксированный список тегов проблем. shortLabel — для кнопок (без обрезки). */
export const PROBLEM_TAGS = [
  { id: "oversalted", label: "⚠️ Пересолено", shortLabel: "⚠️ Пересолено" },
  { id: "hot_should_be_cold", label: "🔥 Горячее (должно быть холодным)", shortLabel: "🔥 Горячее" },
  { id: "cold_should_be_hot", label: "❄️ Холодное (должно быть горячим)", shortLabel: "❄️ Холодное" },
  { id: "long_wait", label: "⏱️ Долгое ожидание", shortLabel: "⏱️ Ожидание" },
  { id: "presentation", label: "🍽️ Подача (оформление)", shortLabel: "🍽️ Подача" },
  { id: "drink_temp", label: "🍷 Температура напитка", shortLabel: "🍷 Температура" },
  { id: "hookah_weak", label: "💨 Вняло горлым (кальян)", shortLabel: "💨 Кальян" },
  { id: "bland", label: "🧂 Пресно", shortLabel: "🧂 Пресно" },
  { id: "product_quality", label: "🦴 Качество продукта", shortLabel: "🦴 Качество" },
] as const;

export type ProblemTagId = (typeof PROBLEM_TAGS)[number]["id"];
export const TAG_IDS = PROBLEM_TAGS.map((t) => t.id);

export function getTagLabel(id: string): string {
  const t = PROBLEM_TAGS.find((x) => x.id === id);
  return t?.label ?? id;
}

/** Текст тега без эмодзи (для экспорта в таблицу). */
function getTagLabelPlain(id: string): string {
  const withEmoji = getTagLabel(id);
  return withEmoji.replace(/^[\p{Emoji}\p{Emoji_Presentation}\s]+/u, "").trim() || withEmoji;
}

export function formatTags(ids: string[]): string {
  return ids.map(getTagLabel).join(", ");
}

/** Теги через запятую без эмодзи (для Google Sheets). */
export function formatTagsPlain(ids: string[]): string {
  return ids.map(getTagLabelPlain).join(", ");
}
