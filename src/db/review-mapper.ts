import type { ReviewRow } from "./schema.js";
import type { BranchId } from "./schema.js";
import type { Review, ReviewRatings } from "../types/review.js";
import { getDepartmentsForBranch } from "../lib/branches.js";

export function rowToReview(row: ReviewRow): Review {
  const branch = row.branch as BranchId;
  const depts = getDepartmentsForBranch(branch);
  const ratings: ReviewRatings = {
    kitchen: depts.includes("kitchen") ? (row.ratingKitchen ?? null) : null,
    bar: row.ratingBar,
    hookah: depts.includes("hookah") ? (row.ratingHookah ?? null) : null,
    service: row.ratingService,
    overall: row.ratingOverall,
  };
  return {
    id: row.id,
    telegramUserId: row.telegramUserId,
    telegramUsername: row.telegramUsername,
    guestName: row.guestName,
    visitDate: row.visitDate,
    branch,
    dishName: row.dishName,
    comment: row.comment,
    ratings,
    tags: row.tags ?? [],
    photos: {
      fileIds: row.photoFileIds ?? [],
      driveLinks: row.driveLinks ?? [],
      driveFolderId: row.driveFolderId ?? null,
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    sheetsRowId: row.sheetsRowId,
    status: row.status as "draft" | "confirmed" | "edited",
  };
}
