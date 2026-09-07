import { createOAuth1, buildSignedApiBody, type Token } from "./oauth1.js";
import type {
  FoodEntryCreateResponse,
  FoodGetResponse,
  FoodSearchItem,
  FoodSearchResponse,
  FoodServing,
} from "./types.js";
import type { Meal } from "../utils/date.js";
import { fetchJson } from "../utils/http.js";
import { logger } from "../utils/logger.js";

const API_URL = "https://platform.fatsecret.com/rest/server.api";

/** Grams represented by one FatSecret `number_of_units` for this serving. */
function gramsPerApiUnit(serving: FoodServing): number | null {
  const metricGrams = parseFloat(serving.metric_serving_amount ?? "");
  const servingUnits = parseFloat(serving.number_of_units ?? "1");
  if (!(metricGrams > 0) || !(servingUnits > 0)) return null;
  return metricGrams / servingUnits;
}

export class FatSecretClient {
  private oauth: ReturnType<typeof createOAuth1>;
  private token: Token;

  constructor(
    consumerKey: string,
    consumerSecret: string,
    accessToken: string,
    accessTokenSecret: string
  ) {
    this.oauth = createOAuth1(consumerKey, consumerSecret);
    this.token = { key: accessToken, secret: accessTokenSecret };
  }

  private async call<T>(params: Record<string, string>): Promise<T> {
    const body = buildSignedApiBody(
      this.oauth,
      { format: "json", ...params },
      this.token
    );
    const data = await fetchJson<T & { error?: { code: string; message: string } }>(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (data.error) {
      throw new Error(`FatSecret API error ${data.error.code}: ${data.error.message}`);
    }
    return data;
  }

  /** foods.search.v3 - text search over the food database. */
  async searchFoods(query: string, maxResults = 5): Promise<FoodSearchItem[]> {
    const data = await this.call<FoodSearchResponse>({
      method: "foods.search",
      search_expression: query,
      max_results: String(maxResults),
    });
    const food = data.foods?.food;
    const items = !food ? [] : Array.isArray(food) ? food : [food];
    logger.info("[pipeline] FatSecret foods.search", {
      query,
      maxResults,
      totalResults: data.foods?.total_results ?? null,
      candidates: items.map((item) => ({
        food_id: item.food_id,
        food_name: item.food_name,
        food_type: item.food_type,
        brand_name: item.brand_name ?? null,
        food_description: item.food_description,
      })),
    });
    return items;
  }

  /** food.get.v4 - full nutrition + serving details for a food_id. */
  async getFood(foodId: string): Promise<{
    foodId: string;
    foodName: string;
    foodType: string | null;
    brandName: string | null;
    servings: FoodServing[];
  }> {
    const data = await this.call<FoodGetResponse>({
      method: "food.get.v4",
      food_id: foodId,
    });
    const raw = data.food?.servings?.serving;
    const servings = raw ? (Array.isArray(raw) ? raw : [raw]) : [];
    const result = {
      foodId: data.food?.food_id ?? foodId,
      foodName: data.food?.food_name ?? "",
      foodType: data.food?.food_type ?? null,
      brandName: data.food?.brand_name ?? null,
      servings,
    };
    logger.info("[pipeline] FatSecret food.get.v4", {
      requestedFoodId: foodId,
      foodId: result.foodId,
      foodName: result.foodName,
      foodType: result.foodType,
      brandName: result.brandName,
      servings: servings.map((s) => ({
        serving_id: s.serving_id,
        serving_description: s.serving_description,
        metric_serving_amount: s.metric_serving_amount ?? null,
        metric_serving_unit: s.metric_serving_unit ?? null,
        number_of_units: s.number_of_units ?? null,
        measurement_description: s.measurement_description ?? null,
        calories: s.calories ?? null,
      })),
    });
    return result;
  }

  /**
   * Picks a gram-based serving and returns `number_of_units` for food_entry.create.
   *
   * FatSecret's diary weight is:
   *   number_of_units * (metric_serving_amount / serving.number_of_units)
   * A "100 g" serving is often `{ metric: 100, number_of_units: 100, measurement: "g" }`,
   * so 120 g must be sent as 120 units, not 120/100 = 1.2.
   */
  pickGramServing(
    servings: FoodServing[],
    grams: number
  ): { servingId: string; numberOfUnits: number } | null {
    const gramServings = servings.filter(
      (s) => s.metric_serving_unit === "g" && gramsPerApiUnit(s) !== null
    );
    const gramServing =
      gramServings.find((s) => s.measurement_description === "g") ?? gramServings[0];
    if (!gramServing) {
      logger.warn("[pipeline] pickGramServing found no gram serving", {
        requestedGrams: grams,
        servingUnits: servings.map((s) => s.metric_serving_unit ?? null),
      });
      return null;
    }

    const perApiUnitGrams = gramsPerApiUnit(gramServing);
    if (perApiUnitGrams === null) return null;

    const numberOfUnits = grams / perApiUnitGrams;
    logger.info("[pipeline] pickGramServing", {
      requestedGrams: grams,
      chosenServing: {
        serving_id: gramServing.serving_id,
        serving_description: gramServing.serving_description,
        metric_serving_amount: gramServing.metric_serving_amount,
        metric_serving_unit: gramServing.metric_serving_unit,
        number_of_units: gramServing.number_of_units ?? null,
        measurement_description: gramServing.measurement_description ?? null,
      },
      formula: "grams / (metric_serving_amount / serving.number_of_units)",
      gramsPerApiUnit: perApiUnitGrams,
      sentNumberOfUnits: numberOfUnits,
      likelyDiaryGrams: numberOfUnits * perApiUnitGrams,
    });
    return {
      servingId: gramServing.serving_id,
      numberOfUnits,
    };
  }

  /** food_entry.create.v2 - logs a diary entry for the currently authorized user. */
  async createFoodEntry(args: {
    foodId: string;
    servingId: string;
    numberOfUnits: number;
    meal: Meal;
    dayInt: number;
    entryName?: string;
  }): Promise<string> {
    const payload = {
      method: "food_entry.create",
      food_id: args.foodId,
      food_entry_name: args.entryName ?? "",
      serving_id: args.servingId,
      number_of_units: String(args.numberOfUnits),
      meal: args.meal,
      date: String(args.dayInt),
    };
    logger.info("[pipeline] FatSecret food_entry.create request", payload);
    const data = await this.call<FoodEntryCreateResponse>(payload);
    const id = data.food_entry_id?.value;
    if (!id) {
      logger.error("[pipeline] Unexpected food_entry.create response", data);
      throw new Error("FatSecret did not return a food_entry_id");
    }
    logger.info("[pipeline] FatSecret food_entry.create response", {
      food_entry_id: id,
      raw: data,
    });
    return id;
  }
}
