import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function csvEnv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const DEFAULT_GEMINI_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
] as const;

const GEMINI_MODEL_ATTEMPTS = 3;

function geminiModelPool(): string[] {
  const listed = csvEnv("GEMINI_MODELS");
  const primary = process.env.GEMINI_MODEL?.trim();
  const ordered = [
    ...listed,
    ...(primary ? [primary] : []),
    ...DEFAULT_GEMINI_MODELS,
  ];
  return [...new Set(ordered)].slice(0, GEMINI_MODEL_ATTEMPTS);
}

export const config = {
  telegram: {
    botToken: required("TELEGRAM_BOT_TOKEN"),
    allowedUserIds: (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number),
  },
  gemini: {
    apiKey: required("GEMINI_API_KEY"),
    models: geminiModelPool(),
  },
  fatsecret: {
    consumerKey: required("FATSECRET_CONSUMER_KEY"),
    consumerSecret: required("FATSECRET_CONSUMER_SECRET"),
    // These two are only required once the bot actually needs to write to the diary.
    // They're empty during the `npm run fatsecret:auth` bootstrap step.
    accessToken: process.env.FATSECRET_ACCESS_TOKEN ?? "",
    accessTokenSecret: process.env.FATSECRET_ACCESS_TOKEN_SECRET ?? "",
  },
  timezone: process.env.TIMEZONE ?? "Europe/Moscow",
};
