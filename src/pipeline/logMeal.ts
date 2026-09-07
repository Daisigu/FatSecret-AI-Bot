import type { GeminiClient, ParsedResponse } from "../gemini/client.ts";
import type { FatSecretClient } from "../fatsecret/client.ts";
import { fatsecretDayInt, guessMeal } from "../utils/date.ts";
import { logger } from "../utils/logger.ts";

export interface ItemResult {
  nameRu: string;
  grams: number;
  status: "logged" | "no_match" | "no_gram_serving" | "error";
  matchedFoodName?: string;
  errorMessage?: string;
}

export interface LogMealResult {
  items: ItemResult[];
  clarificationNeeded?: string;
}

const SEARCH_CANDIDATES = 5;

export async function logMealFromVoice(
  audio: Buffer,
  gemini: GeminiClient,
  fatsecret: FatSecretClient,
  timezone: string
): Promise<LogMealResult> {
  const extracted = await gemini.extractFoodItemsFromVoice(audio);
  return logExtractedMeal(extracted, gemini, fatsecret, timezone);
}

export async function logMealFromText(
  text: string,
  gemini: GeminiClient,
  fatsecret: FatSecretClient,
  timezone: string
): Promise<LogMealResult> {
  const extracted = await gemini.extractFoodItemsFromText(text);
  return logExtractedMeal(extracted, gemini, fatsecret, timezone);
}

export async function logMealFromPhoto(
  image: Buffer,
  mimeType: string,
  gemini: GeminiClient,
  fatsecret: FatSecretClient,
  timezone: string,
  caption?: string
): Promise<LogMealResult> {
  const extracted = await gemini.extractFoodItemsFromPhoto(image, mimeType, caption);
  return logExtractedMeal(extracted, gemini, fatsecret, timezone);
}

async function logExtractedMeal(
  extracted: ParsedResponse,
  gemini: GeminiClient,
  fatsecret: FatSecretClient,
  timezone: string
): Promise<LogMealResult> {

  if (extracted.items.length === 0) {
    logger.info("[pipeline] no food items extracted", {
      clarificationNeeded: extracted.clarification_needed ?? null,
    });
    return { items: [], clarificationNeeded: extracted.clarification_needed ?? undefined };
  }

  // 1. Search FatSecret for each item in parallel.
  const candidatesByItem = await Promise.all(
    extracted.items.map((item) =>
      fatsecret.searchFoods(item.food_query_en, SEARCH_CANDIDATES).catch((err) => {
        logger.error(`[pipeline] foods.search failed for "${item.food_query_en}"`, err);
        return [];
      })
    )
  );

  // 2. Ask Gemini to pick the best food_id among candidates for each item.
  const chosenFoodIds = await gemini.matchBestCandidates(
    extracted.items.map((item) => ({ query: item.food_query_en, grams: item.grams })),
    candidatesByItem
  );

  const meal = guessMeal(timezone);
  const dayInt = fatsecretDayInt(timezone);
  logger.info("[pipeline] diary target", { meal, dayInt, timezone });

  const results: ItemResult[] = [];

  for (let i = 0; i < extracted.items.length; i++) {
    const item = extracted.items[i];
    const foodId = chosenFoodIds[i];

    if (!foodId) {
      logger.warn("[pipeline] no food_id chosen", {
        nameRu: item.food_name_ru,
        query: item.food_query_en,
        grams: item.grams,
      });
      results.push({ nameRu: item.food_name_ru, grams: item.grams, status: "no_match" });
      continue;
    }

    try {
      const { foodName, servings } = await fatsecret.getFood(foodId);
      const servingChoice = fatsecret.pickGramServing(servings, item.grams);

      if (!servingChoice) {
        results.push({
          nameRu: item.food_name_ru,
          grams: item.grams,
          status: "no_gram_serving",
          matchedFoodName: foodName,
        });
        continue;
      }

      await fatsecret.createFoodEntry({
        foodId,
        servingId: servingChoice.servingId,
        numberOfUnits: servingChoice.numberOfUnits,
        meal,
        dayInt,
        entryName: item.food_name_ru,
      });

      results.push({
        nameRu: item.food_name_ru,
        grams: item.grams,
        status: "logged",
        matchedFoodName: foodName,
      });
    } catch (err) {
      logger.error(`[pipeline] Failed to log "${item.food_name_ru}"`, err);
      results.push({
        nameRu: item.food_name_ru,
        grams: item.grams,
        status: "error",
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info("[pipeline] done", { items: results });
  return { items: results };
}
