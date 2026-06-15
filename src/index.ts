import { bot } from "./bot/index.js";
import { config } from "./config.js";
import { processDraftReminders } from "./services/draft-reminder.js";
import { processSyncQueue } from "./services/sync-queue.js";

async function getFileBufferFromBot(fileId: string): Promise<Buffer> {
  const token = config.botToken;
  const file = await bot.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to download file");
  const buf = await res.arrayBuffer();
  return Buffer.from(buf);
}

setInterval(() => {
  processSyncQueue(getFileBufferFromBot).catch((e) =>
    console.error("Sync queue error:", e),
  );
}, 60_000);

// Проверяем напоминания каждые 10 секунд для большей точности интервалов
setInterval(() => {
  processDraftReminders().catch((e) =>
    console.error("Draft reminder error:", e),
  );
}, 10_000);

console.log("Starting bot...");
console.log("Loaded Admin IDs:", config.adminIds);
await bot.start();
