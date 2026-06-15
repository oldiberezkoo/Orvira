import { z } from "zod";
import { BRANCHES } from "../db/schema.js";
import { TAG_IDS } from "./tags.js";

/** Минимум 2 слова, только буквы/дефис/пробелы, без падения на краевых пробелах и множественных пробелах */
function parseWords(s: string): string[] {
  return s.trim().split(/\s+/).filter((w) => w.length > 0);
}

export const guestNameSchema = z
  .string()
  .min(2)
  .transform((s) => s.trim())
  .refine((s) => s.length >= 2, "Введите имя и фамилию (минимум 2 слова)")
  .refine((s) => /^[а-яА-ЯёЁa-zA-Z\s\-]+$/.test(s), "Только буквы, без цифр")
  .refine((s) => parseWords(s).length >= 2, "Введите имя и фамилию, по желанию отчество (минимум 2 слова)");

export const visitDateSchema = z
  .string()
  .transform((s) => s.trim())
  .refine(
    (s) => s === "Сегодня" || s === "Вчера" || s === "Послевчера" || /^\d{2}\.\d{2}\.\d{4}$/.test(s),
    "Введите «Сегодня», «Вчера», «Послевчера» или дату ДД.ММ.ГГГГ"
  );

export const branchSchema = z.enum(BRANCHES as unknown as [string, ...string[]]);

export const dishNameSchema = z
  .string()
  .min(3, "Минимум 3 символа")
  .max(60, "Максимум 60 символов")
  .trim();

export const commentSchema = z
  .string()
  .min(10, "Минимум 10 символов")
  .max(1000, "Максимум 1000 символов")
  .trim();

/** Комментарий к цеху: необязательный, до 1000 символов */
export const departmentCommentSchema = z
  .string()
  .max(1000, "Максимум 1000 символов")
  .trim()
  .transform((s) => s || "");

export const ratingSchema = z
  .number()
  .int()
  .min(1, "Оценка от 1 до 5")
  .max(5, "Оценка от 1 до 5");

export const tagsSchema = z.array(z.enum(TAG_IDS as unknown as [string, ...string[]])).optional();

export const PHOTO_MAX_COUNT = 10;

export function parseVisitDate(input: string): Date {
  const trimmed = input.trim();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (trimmed === "Сегодня") return new Date(today);
  if (trimmed === "Вчера") {
    const d = new Date(today);
    d.setDate(d.getDate() - 1);
    return d;
  }
  if (trimmed === "Послевчера") {
    const d = new Date(today);
    d.setDate(d.getDate() - 2);
    return d;
  }
  const [d, m, y] = trimmed.split(".").map(Number);
  if (!d || !m || !y) throw new Error("Неверный формат даты");
  const date = new Date(y, m - 1, d);
  if (isNaN(date.getTime()) || date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) {
    throw new Error("Некорректная дата");
  }
  return date;
}
