function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function optionalEnv(name: string): string | undefined {
  return process.env[name];
}

export const config = {
  botToken: requireEnv("BOT_TOKEN"),
  databaseUrl: requireEnv("DATABASE_URL"),
  adminIds: (optionalEnv("ADMIN_IDS") ?? "")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n)),
  sheetsSpreadsheetId: optionalEnv("SHEETS_SPREADSHEET_ID"),
  sheetsSheetName: optionalEnv("SHEETS_SHEET_NAME") ?? "Отзывы",
  /** Корневая папка для отзывов в Google Drive (общая папка, не сервисный аккаунт). */
  driveSharedFolderId: optionalEnv("DRIVE_SHARED_FOLDER_ID"),
  /** @deprecated Используйте DRIVE_SHARED_FOLDER_ID для загрузки в общую папку. */
  driveReviewsFolderId: optionalEnv("DRIVE_REVIEWS_FOLDER_ID"),
  /** GCS Bucket name */
  gcsBucket: optionalEnv("GCS_BUCKET"),
  /** GCS Project ID */
  gcsProjectId: optionalEnv("GCS_PROJECT_ID"),
  /** @deprecated use GCS */
  driveUserEmail: optionalEnv("GOOGLE_DRIVE_USER_EMAIL"),
  googleCredentialsPath: optionalEnv("GOOGLE_APPLICATION_CREDENTIALS"),

  googleCredentialsBase64: optionalEnv("GOOGLE_CREDENTIALS_BASE64"),
  sessionTtlSeconds: 30 * 60, // 30 min
  editWindowHours: 24,
} as const;

export function isAdmin(telegramUserId: number): boolean {
  return config.adminIds.includes(telegramUserId);
}
