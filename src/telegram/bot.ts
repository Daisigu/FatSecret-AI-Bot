import { Bot, type Context } from "grammy";
import { config } from "../config.ts";
import { GeminiClient } from "../gemini/client.ts";
import { FatSecretClient } from "../fatsecret/client.ts";
import {
  logMealFromPhoto,
  logMealFromText,
  logMealFromVoice,
  type ItemResult,
  type LogMealResult,
} from "../pipeline/logMeal.ts";
import { fetchBuffer } from "../utils/http.ts";
import { logger } from "../utils/logger.ts";
import type { Meal } from "../utils/date.ts";

const MEAL_LABELS_RU: Record<Meal, string> = {
  breakfast: "завтрак",
  lunch: "обед",
  dinner: "ужин",
  other: "перекус",
};

function formatItem(item: ItemResult): string {
  switch (item.status) {
    case "logged":
      return `✅ ${item.nameRu} — ${item.grams} г (${item.matchedFoodName})`;
    case "no_match":
      return `❓ ${item.nameRu} — ${item.grams} г: не нашёл подходящий продукт в базе FatSecret`;
    case "no_gram_serving":
      return `⚠️ ${item.nameRu} — ${item.grams} г: нашёл "${item.matchedFoodName}", но у него нет порции в граммах`;
    case "error":
      return `⚠️ ${item.nameRu} — ${item.grams} г: ошибка при записи (${item.errorMessage})`;
    default: {
      const _exhaustive: never = item;
      return _exhaustive;
    }
  }
}

function clarificationReply(result: LogMealResult): string {
  if (result.items.length === 0) {
    return result.clarificationNeeded
      ? `🤔 ${result.clarificationNeeded}`
      : "🤔 Не удалось разобрать еду в сообщении. Попробуй ещё раз, назвав продукт и вес в граммах.";
  }
  const lines = result.items.map(formatItem).join("\n");
  if (!result.meal) return lines;
  return `Записал в ${MEAL_LABELS_RU[result.meal]}:\n${lines}`;
}

async function downloadTelegramFile(botToken: string, filePath: string): Promise<Buffer> {
  const url = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  return fetchBuffer(url);
}

async function runWithStatusMessage(
  ctx: Context,
  pendingText: string,
  errorText: string,
  work: () => Promise<LogMealResult>
): Promise<void> {
  const processingMsg = await ctx.reply(pendingText);
  try {
    const result = await work();
    await ctx.api.editMessageText(
      processingMsg.chat.id,
      processingMsg.message_id,
      clarificationReply(result)
    );
  } catch (err) {
    logger.error("Failed to process meal message", err);
    await ctx.api.editMessageText(processingMsg.chat.id, processingMsg.message_id, errorText);
  }
}

export function createBot() {
  const bot = new Bot(config.telegram.botToken);
  const gemini = new GeminiClient(config.gemini.apiKey, config.gemini.models);
  const fatsecret = new FatSecretClient(
    config.fatsecret.consumerKey,
    config.fatsecret.consumerSecret,
    config.fatsecret.accessToken,
    config.fatsecret.accessTokenSecret
  );

  const inflight = new Set<number>();

  // Restrict the bot to a fixed set of Telegram user IDs (this is a
  // single-user diary bot; it writes to one FatSecret account).
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (config.telegram.allowedUserIds.length > 0 && !config.telegram.allowedUserIds.includes(userId ?? -1)) {
      await ctx.reply(`Доступ запрещён. Твой Telegram ID: ${userId}`);
      return;
    }
    await next();
  });

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    const text = ctx.message?.text;
    if (userId == null || text?.startsWith("/")) {
      await next();
      return;
    }
    if (inflight.has(userId)) {
      await ctx.reply("⏳ Ещё обрабатываю предыдущее сообщение...");
      return;
    }
    inflight.add(userId);
    try {
      await next();
    } finally {
      inflight.delete(userId);
    }
  });

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Привет! Напиши текстом, пришли голосовое или фото того, что ты съел — например:\n" +
        '"Я съел 120 грам нектарина и 50 грам персиков"\n' +
        "На фото можно подписать вес, например «200г». Запишу в твой дневник FatSecret."
    );
  });

  bot.command("id", async (ctx) => {
    await ctx.reply(`Твой Telegram ID: ${ctx.from?.id ?? "неизвестен"}`);
  });

  bot.on("message:voice", async (ctx) => {
    await runWithStatusMessage(
      ctx,
      "🎧 Слушаю и записываю в дневник...",
      "❌ Что-то пошло не так при обработке голосового сообщения. Попробуй ещё раз.",
      async () => {
        const file = await ctx.api.getFile(ctx.message.voice.file_id);
        if (!file.file_path) throw new Error("Telegram did not return a file_path");

        logger.info("[pipeline] voice received", {
          userId: ctx.from?.id,
          durationSec: ctx.message.voice.duration,
          fileId: ctx.message.voice.file_id,
          filePath: file.file_path,
        });

        const audio = await downloadTelegramFile(config.telegram.botToken, file.file_path);
        logger.info("[pipeline] voice downloaded", { bytes: audio.length });
        return logMealFromVoice(audio, gemini, fatsecret, config.timezone);
      }
    );
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (!text || text.startsWith("/")) return;

    await runWithStatusMessage(
      ctx,
      "📝 Читаю и записываю в дневник...",
      "❌ Что-то пошло не так при обработке текстового сообщения. Попробуй ещё раз.",
      async () => {
        logger.info("[pipeline] text received", {
          userId: ctx.from?.id,
          text,
        });
        return logMealFromText(text, gemini, fatsecret, config.timezone);
      }
    );
  });

  async function processMealPhoto(ctx: Context, fileId: string, mimeType: string): Promise<void> {
    await runWithStatusMessage(
      ctx,
      "📷 Смотрю фото и записываю в дневник...",
      "❌ Что-то пошло не так при обработке фото. Попробуй ещё раз.",
      async () => {
        const file = await ctx.api.getFile(fileId);
        if (!file.file_path) throw new Error("Telegram did not return a file_path");

        const caption = ctx.message?.caption?.trim();
        logger.info("[pipeline] photo received", {
          userId: ctx.from?.id,
          fileId,
          filePath: file.file_path,
          mimeType,
          caption: caption ?? null,
        });

        const image = await downloadTelegramFile(config.telegram.botToken, file.file_path);
        logger.info("[pipeline] photo downloaded", { bytes: image.length });
        return logMealFromPhoto(image, mimeType, gemini, fatsecret, config.timezone, caption);
      }
    );
  }

  bot.on("message:photo", async (ctx) => {
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];
    if (!largest) return;
    await processMealPhoto(ctx, largest.file_id, "image/jpeg");
  });

  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    const mimeType = doc.mime_type ?? "";
    if (!mimeType.startsWith("image/")) return;
    await processMealPhoto(ctx, doc.file_id, mimeType);
  });

  bot.catch((err) => {
    logger.error("Unhandled bot error", err);
  });

  return bot;
}
