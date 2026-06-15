import { db } from "../db/index.js";
import { syncQueue, reviews } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { appendReviewToSheets, updateReviewInSheets } from "./sheets.js";

export async function processSyncQueue(getFileBuffer: (fileId: string) => Promise<Buffer>): Promise<void> {
  const items = await db.select().from(syncQueue).where(eq(syncQueue.attempts, 0)).limit(20);
  for (const item of items) {
    await db.update(syncQueue).set({ attempts: item.attempts + 1 }).where(eq(syncQueue.id, item.id));
    try {
      if (item.kind === "sheets") {
        const payload = item.payload as { action: string; row?: string[]; sheetsRowId?: number };
        const review = await db.select().from(reviews).where(eq(reviews.id, item.reviewId)).then((r) => r[0]);
        if (!review) continue;
        if (payload.action === "append") {
          const rowId = await appendReviewToSheets(review);
          if (rowId != null) await db.update(reviews).set({ sheetsRowId: rowId, updatedAt: new Date() }).where(eq(reviews.id, review.id));
        } else if (payload.action === "update" && typeof payload.sheetsRowId === "number") {
          await updateReviewInSheets(review, payload.sheetsRowId);
        }
      } else if (item.kind === "drive") {
        const payload = item.payload as { visitDate: string; fileIds: string[] };
        const review = await db.select().from(reviews).where(eq(reviews.id, item.reviewId)).then((r) => r[0]);
        if (!review) continue;
        const { uploadReviewPhotos } = await import("./drive.js");
        const result = await uploadReviewPhotos(
          review.branch as never,
          new Date(payload.visitDate),
          review.id,
          payload.fileIds,
          getFileBuffer
        );
        if (result) {
          await db
            .update(reviews)
            .set({
              driveLinks: result.fileLinks,
              driveFolderId: result.folderId,
              updatedAt: new Date(),
            })
            .where(eq(reviews.id, review.id));

          if (review.sheetsRowId != null) {
            const updatedReview = { ...review, driveLinks: result.fileLinks, driveFolderId: result.folderId };
            await updateReviewInSheets(updatedReview, review.sheetsRowId);
          }
        }
      }
      await db.delete(syncQueue).where(eq(syncQueue.id, item.id));
    } catch (e) {
      await db
        .update(syncQueue)
        .set({ lastError: e instanceof Error ? e.message : String(e) })
        .where(eq(syncQueue.id, item.id));
    }
  }
}
