import type { BranchId } from "../db/schema.js";

export interface ReviewRatings {
  kitchen: number | null;
  bar: number | null;
  hookah: number | null;
  service: number | null;
  overall: number;
}

export interface ReviewPhotos {
  fileIds: string[];
  driveLinks: string[];
  driveFolderId: string | null;
}

export interface Review {
  id: string;
  telegramUserId: number;
  telegramUsername: string | null;
  guestName: string;
  visitDate: Date;
  branch: BranchId;
  dishName: string;
  comment: string;
  ratings: ReviewRatings;
  tags: string[];
  photos: ReviewPhotos;
  createdAt: Date;
  updatedAt: Date;
  sheetsRowId: number | null;
  status: "draft" | "confirmed" | "edited";
}
