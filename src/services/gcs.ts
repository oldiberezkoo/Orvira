import { Storage, type GetSignedUrlConfig } from "@google-cloud/storage";
import { config } from "../config.js";
import { db } from "../db/index.js";
import type { BranchId } from "../db/schema.js";
import { syncQueue } from "../db/schema.js";
import { createId } from "../lib/uuid.js";
import { getCredentials } from "./google-auth.js";

export interface UploadResult {
  folderId: string;
  folderLink: string;
  fileLinks: string[];
}

const MIME_JPEG = "image/jpeg";
const MIME_PNG = "image/png";

function detectImageMimeType(buffer: Buffer): { ext: string; mime: string } {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    return { ext: "jpg", mime: MIME_JPEG };
  }
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return { ext: "png", mime: MIME_PNG };
  }
  return { ext: "png", mime: MIME_PNG };
}

function getObjectPrefix(visitDate: Date, reviewId: string): string {
  const d = visitDate.getDate();
  const m = visitDate.getMonth() + 1;
  const y = visitDate.getFullYear();
  const dateStr = `${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}.${y}`;
  return `reviews/${dateStr}/${reviewId}`;
}

let storageInstance: Storage | null = null;

function getStorage(): Storage {
  if (storageInstance) return storageInstance;
  
  const credentials = getCredentials();
  storageInstance = new Storage({
    projectId: config.gcsProjectId || credentials.project_id,
    credentials,
  });
  return storageInstance;
}

/**
 * Returns a signed URL that lasts for a very long time (e.g. 100 years).
 * Uses V2 signing because V4 is limited to 7 days.
 * This is the best approach for private buckets (Uniform Bucket Level Access)
 * where we want to share specific files "forever".
 */
async function getPermanentSignedUrl(bucketName: string, fileName: string): Promise<string> {
  const storage = getStorage();
  
  // Expiration: 100 years from now
  const expires = new Date();
  expires.setFullYear(expires.getFullYear() + 100);

  const options: GetSignedUrlConfig = {
    version: 'v2', 
    action: 'read',
    expires,
  };

  const [url] = await storage
    .bucket(bucketName)
    .file(fileName)
    .getSignedUrl(options);

  return url;
}

export async function uploadReviewPhotos(
  _branch: BranchId,
  visitDate: Date,
  reviewId: string,
  fileIds: string[],
  getFileBuffer: (fileId: string) => Promise<Buffer>
): Promise<UploadResult | null> {
  const bucketName = config.gcsBucket;
  if (!bucketName) {
    console.warn("GCS_BUCKET not configured");
    return { folderId: "", folderLink: "", fileLinks: [] };
  }

  if (fileIds.length === 0) {
    return { folderId: "", folderLink: "", fileLinks: [] };
  }

  try {
    const storage = getStorage();
    const bucket = storage.bucket(bucketName);
    const prefix = getObjectPrefix(visitDate, reviewId);
    
    console.log(`Uploading ${fileIds.length} files to GCS bucket ${bucketName} with prefix ${prefix}`);

    const uploadPromises = fileIds.map(async (fileId, i) => {
      const buf = await getFileBuffer(fileId);
      if (buf.length === 0) return null;

      const { ext, mime } = detectImageMimeType(buf);
      const fileName = `${prefix}/photo_${i + 1}.${ext}`;
      const file = bucket.file(fileName);

      // Save file without ACLs (to support Uniform Bucket Level Access)
      await file.save(buf, {
        contentType: mime,
        resumable: false, 
        validation: 'crc32c',
      });

      // Generate signed URL
      return getPermanentSignedUrl(bucketName, fileName);
    });

    const results = await Promise.all(uploadPromises);
    const fileLinks = results.filter((link): link is string => link !== null);

    if (fileLinks.length === 0) {
       return { folderId: prefix, folderLink: "", fileLinks: [] };
    }

    const folderLink = fileLinks.join("\n");

    return {
      folderId: prefix,
      folderLink,
      fileLinks,
    };
  } catch (err) {
    console.error("GCS Upload failed:", err);

    await db.insert(syncQueue).values({
      id: createId(),
      reviewId,
      kind: "drive",
      payload: { visitDate: visitDate.toISOString(), fileIds },
      lastError: err instanceof Error ? err.message : String(err),
    });

    return null;
  }
}

export async function addPhotosToExistingFolder(
  folderId: string,
  fileIds: string[],
  getFileBuffer: (fileId: string) => Promise<Buffer>
): Promise<string[]> {
  const bucketName = config.gcsBucket;
  if (!bucketName || !folderId || fileIds.length === 0) return [];

  try {
    const storage = getStorage();
    const bucket = storage.bucket(bucketName);

    // Get existing files to determine index
    const [files] = await bucket.getFiles({ prefix: folderId });
    const startIndex = files.length + 1;

    const uploadPromises = fileIds.map(async (fileId, i) => {
      const buf = await getFileBuffer(fileId);
      if (buf.length === 0) return null;

      const { ext, mime } = detectImageMimeType(buf);
      const fileName = `${folderId}/photo_${startIndex + i}.${ext}`;
      
      await bucket.file(fileName).save(buf, {
        contentType: mime,
        resumable: false,
        validation: 'crc32c',
      });

      return getPermanentSignedUrl(bucketName, fileName);
    });

    const results = await Promise.all(uploadPromises);
    return results.filter((link): link is string => link !== null);
  } catch (err) {
    console.error("GCS Add photos failed:", err);
    return [];
  }
}
