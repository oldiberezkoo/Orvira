/**
 * This service previously used Google Drive, but has been migrated to Google Cloud Storage (GCS)
 * for better performance, security (signed URLs), and reliability.
 * 
 * We keep the filename as drive.ts to avoid breaking imports throughout the codebase,
 * but the implementation is now backed by GCS.
 */

export { 
  uploadReviewPhotos, 
  addPhotosToExistingFolder,
  type UploadResult 
} from "./gcs.js";
