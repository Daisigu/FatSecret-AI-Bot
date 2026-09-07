import { Bot } from "grammy";
import { config } from "../config.js";
import { GeminiClient } from "../gemini/client.js";
import { FatSecretClient } from "../fatsecret/client.js";
import { logMealFromPhoto, logMealFromText, logMealFromVoice, type ItemResult, type LogMealResult } from "../pipeline/logMeal.js";
import { fetchBuffer } from "../utils/http.js";
import { logger } from "../utils/logger.js";

const MEAL_LABELS_RU: Record<string, string> = {
  breakfast: "завтрак",
  lunch: "обед",
  dinner: "ужин",
  other: "перекус",
};

function formatResults(items: ItemResult[]): string {
  const lines = items.map((item) => {
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
        const _exhaustive: never = item.status;
        return _exhaustive;
      }
    }
  });
  return lines.join("\n");
}

function clarificationReply(result: LogMealResult): string {
  if (result.items.length === 0) {
    return result.clarificationNeeded
      ? `🤔 ${result.clarificationNeeded}`
      : "🤔 Не удалось разобрать еду в сообщении. Попробуй ещё раз, назвав продукт и вес в граммах.";
  }
  return formatResults(result.items);
}

async function downloadTelegramFile(botToken: string, filePath: string): Promise<Buffer> {
  const url = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  return fetchBuffer(url);
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

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Привет! Напиши текстом, пришли голосовое или фото того, что ты съел — например:\n" +
        '"Я съел 120 грам нектарина и 50 грам персиков"\n' +
        "На фото можно подписать вес, например «200г». Запишу в твой дневник FatSecret."
    );
  });

  bot.on("message:voice", async (ctx) => {
    const processingMsg = await ctx.reply("🎧 Слушаю и записываю в дневник...");

    try {
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
      const result = await logMealFromVoice(audio, gemini, fatsecret, config.timezone);
      await ctx.api.editMessageText(ctx.chat.id, processingMsg.message_id, clarificationReply(result));
    } catch (err) {
      logger.error("Failed to process voice message", err);
      await ctx.api.editMessageText(
        ctx.chat.id,
        processingMsg.message_id,
        "❌ Что-то пошло не так при обработке голосового сообщения. Попробуй ещё раз."
      );
    }
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (!text || text.startsWith("/")) return;

    const processingMsg = await ctx.reply("📝 Читаю и записываю в дневник...");

    try {
      logger.info("[pipeline] text received", {
        userId: ctx.from?.id,
        text,
      });
      const result = await logMealFromText(text, gemini, fatsecret, config.timezone);
      await ctx.api.editMessageText(ctx.chat.id, processingMsg.message_id, clarificationReply(result));
    } catch (err) {
      logger.error("Failed to process text message", err);
      await ctx.api.editMessageText(
        ctx.chat.id,
        processingMsg.message_id,
        "❌ Что-то пошло не так при обработке текстового сообщения. Попробуй ещё раз."
      );
    }
  });

  async function processMealPhoto(args: {
    userId: number | undefined;
    fileId: string;
    mimeType: string;
    caption?: string;
    chatId: number;
  }): Promise<void> {
    const processingMsg = await bot.api.sendMessage(
      args.chatId,
      "📷 Смотрю фото и записываю в дневник..."
    );

    try {
      const file = await bot.api.getFile(args.fileId);
      if (!file.file_path) throw new Error("Telegram did not return a file_path");

      logger.info("[pipeline] photo received", {
        userId: args.userId,
        fileId: args.fileId,
        filePath: file.file_path,
        mimeType: args.mimeType,
        caption: args.caption ?? null,
      });

      const image = await downloadTelegramFile(config.telegram.botToken, file.file_path);
      logger.info("[pipeline] photo downloaded", { bytes: image.length });
      const result = await logMealFromPhoto(
        image,
        args.mimeType,
        gemini,
        fatsecret,
        config.timezone,
        args.caption
      );
      await bot.api.editMessageText(args.chatId, processingMsg.message_id, clarificationReply(result));
    } catch (err) {
      logger.error("Failed to process photo message", err);
      await bot.api.editMessageText(
        args.chatId,
        processingMsg.message_id,
        "❌ Что-то пошло не так при обработке фото. Попробуй ещё раз."
      );
    }
  }

  bot.on("message:photo", async (ctx) => {
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];
    if (!largest) return;
    await processMealPhoto({
      userId: ctx.from?.id,
      fileId: largest.file_id,
      mimeType: "image/jpeg",
      caption: ctx.message.caption?.trim(),
      chatId: ctx.chat.id,
    });
  });

  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    const mimeType = doc.mime_type ?? "";
    if (!mimeType.startsWith("image/")) return;
    await processMealPhoto({
      userId: ctx.from?.id,
      fileId: doc.file_id,
      mimeType,
      caption: ctx.message.caption?.trim(),
      chatId: ctx.chat.id,
    });
  });

  bot.catch((err) => {
    logger.error("Unhandled bot error", err);
  });

  return bot;
}
