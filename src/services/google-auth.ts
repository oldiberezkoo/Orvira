import { readFileSync } from "fs";
import { google } from "googleapis";

export interface GoogleServiceAccountCredentials {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
  auth_provider_x509_cert_url: string;
  client_x509_cert_url: string;
}

export function getCredentials(): GoogleServiceAccountCredentials {
  const base64 = process.env.GOOGLE_CREDENTIALS_BASE64;
  if (base64) {
    const json = Buffer.from(base64, "base64").toString("utf-8");
    return JSON.parse(json) as GoogleServiceAccountCredentials;
  }

  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (path) {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as GoogleServiceAccountCredentials;
  }

  throw new Error(
    "Set GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_CREDENTIALS_BASE64"
  );
}

/**
 * Создаёт Google Auth с возможностью делегирования (impersonation)
 *
 * @param userEmail - Email пользователя, от имени которого будет работать сервисный аккаунт
 * Если не указан, работает как обычный сервисный аккаунт (может не работать с My Drive)
 */
export function getAuth(userEmail?: string) {
  const creds = getCredentials();

  // Если указан email для делегирования
  if (userEmail) {
    console.log(`Using domain-wide delegation for user: ${userEmail}`);

    const auth = new google.auth.JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/drive.file",
      ],
      subject: userEmail, // Ключевой параметр - от чьего имени работаем
    });

    return auth;
  }

  // Обычный режим сервисного аккаунта
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/drive.file",
    ],
  });

  return auth;
}
