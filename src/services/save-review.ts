import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import type { Context } from "../bot/context.js";
import { db } from "../db/index.js";
import { reviews } from "../db/schema.js";
import type { BranchId } from "../db/schema.js";
import { createId } from "../lib/uuid.js";
import { getDepartmentsForBranch } from "../lib/branches.js";
import { appendReviewToSheets, updateReviewInSheets } from "./sheets.js";
import { uploadReviewPhotos } from "./drive.js";
import { notifyAdminsNewReview } from "./admin-notify.js";
import type { DraftReview } from "../session/types.js";

export interface SaveResult {
  ok: boolean;
  reviewId: string;
  sheetsSynced: boolean;
  driveSynced: boolean;
}

export async function saveReviewFromDraft(ctx: Context, draft: DraftReview): Promise<SaveResult> {
  const branch = draft.branch!;
  const depts = getDepartmentsForBranch(branch);
  const definedDepts = depts.filter((d) => draft.ratings?.[d] != null);
  const overall =
    definedDepts.length > 0
      ? Math.round(
          definedDepts.reduce((s, d) => s + (draft.ratings?.[d] ?? 0), 0) /
            definedDepts.length
        )
      : 0;

  const reviewId = createId();
  const userId = ctx.from?.id ?? 0;
  const username = ctx.from?.username ?? null;

  const now = new Date();
  const row = {
    id: reviewId,
    telegramUserId: userId,
    telegramUsername: username,
    guestName: draft.guestName!,
    visitDate: draft.visitDate!,
    branch,
    dishName: draft.dishName!,
    comment: draft.comment!,
    ratingKitchen: depts.includes("kitchen") ? (draft.ratings?.kitchen ?? null) : null,
    ratingBar: draft.ratings?.bar ?? 0,
    ratingHookah: depts.includes("hookah") ? (draft.ratings?.hookah ?? null) : null,
    ratingService: draft.ratings?.service ?? 0,
    ratingOverall: overall,
    tags: draft.tags ?? [],
    photoFileIds: draft.photoFileIds ?? [],
    driveLinks: [] as string[],
    driveFolderId: null as string | null,
    sheetsRowId: null as number | null,
    status: "confirmed" as const,
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(reviews).values(row);

  let sheetsRowId: number | null = null;
  try {
    sheetsRowId = await appendReviewToSheets(row as never);
    if (sheetsRowId != null) {
      await db.update(reviews).set({ sheetsRowId, updatedAt: new Date() }).where(eq(reviews.id, reviewId));
    }
  } catch {
    // already queued in appendReviewToSheets
  }

  let driveFolderId: string | null = null;
  let driveLinks: string[] = [];
  const fileIds = draft.photoFileIds ?? [];
  if (fileIds.length > 0) {
    let tempDir: string | null = null;
    try {
      tempDir = await mkdtemp(join(tmpdir(), `rsxr-${reviewId}-`));
      const pathByIndex: string[] = [];
      for (let i = 0; i < fileIds.length; i++) {
        const file = await ctx.api.getFile(fileIds[i]);
        const url = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error("Failed to download file");
        const buf = Buffer.from(await res.arrayBuffer());
        const ext = buf[0] === 0xff && buf[1] === 0xd8 ? "jpg" : "png";
        const localPath = join(tempDir, `photo_${i}.${ext}`);
        const { writeFile } = await import("node:fs/promises");
        await writeFile(localPath, buf);
        pathByIndex.push(localPath);
      }
      const getFileBuffer = async (fileId: string) => {
        const idx = fileIds.indexOf(fileId);
        if (idx === -1) throw new Error("Unknown fileId");
        return readFile(pathByIndex[idx]);
      };
      const upload = await uploadReviewPhotos(branch, draft.visitDate!, reviewId, fileIds, getFileBuffer);
      if (upload) {
        driveFolderId = upload.folderId;
        driveLinks = upload.fileLinks;
        await db
          .update(reviews)
          .set({
            driveLinks,
            driveFolderId,
            updatedAt: new Date(),
          })
          .where(eq(reviews.id, reviewId));
        
        if (sheetsRowId != null) {
          const updatedRow = { ...row, driveLinks, driveFolderId, sheetsRowId };
          await updateReviewInSheets(updatedRow as never, sheetsRowId);
        }
      }
    } finally {
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  await notifyAdminsNewReview({
    ...row,
    id: reviewId,
    driveFolderId,
    driveLinks,
    sheetsRowId,
  });

  return {
    ok: sheetsRowId != null && (fileIds.length === 0 || driveFolderId !== null),
    reviewId,
    sheetsSynced: sheetsRowId != null,
    driveSynced: fileIds.length === 0 || driveFolderId !== null,
  };
}
