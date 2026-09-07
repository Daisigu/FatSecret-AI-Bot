import { config } from "./config.ts";
import { createBot } from "./telegram/bot.ts";
import { logger } from "./utils/logger.ts";

if (!config.fatsecret.accessToken || !config.fatsecret.accessTokenSecret) {
  logger.warn(
    "FATSECRET_ACCESS_TOKEN(_SECRET) is not set - run `npm run fatsecret:auth` first, " +
      "otherwise diary writes will fail with an auth error."
  );
}

const bot = createBot();

bot.start({
  drop_pending_updates: true,
  onStart: () => logger.info("Bot started (long polling)", { models: config.gemini.models }),
});

process.once("SIGINT", () => bot.stop());
process.once("SIGTERM", () => bot.stop());
