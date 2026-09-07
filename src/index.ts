import { config } from "./config.js";
import { createBot } from "./telegram/bot.js";
import { logger } from "./utils/logger.js";

if (!config.fatsecret.accessToken || !config.fatsecret.accessTokenSecret) {
  logger.warn(
    "FATSECRET_ACCESS_TOKEN(_SECRET) is not set - run `npm run fatsecret:auth` first, " +
      "otherwise diary writes will fail with an auth error."
  );
}

const bot = createBot();

bot.start({
  onStart: () => logger.info("Bot started (long polling)", { models: config.gemini.models }),
});

process.once("SIGINT", () => bot.stop());
process.once("SIGTERM", () => bot.stop());
