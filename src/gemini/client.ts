import { GoogleGenAI } from "@google/genai";
import type { Interactions } from "@google/genai";
import { z } from "zod";
import type { FoodSearchItem } from "../fatsecret/types.js";
import { logger } from "../utils/logger.js";

function getOutputText(interaction: Interactions.Interaction): string {
  return interaction.output_text ?? "";
}

function jsonTextFormat(schema: Record<string, unknown>): Interactions.TextResponseFormat {
  return {
    type: "text",
    mime_type: "application/json",
    schema,
  };
}

const ParsedItemSchema = z.object({
  // Short English search term for the FatSecret food database, e.g. "nectarine".
  food_query_en: z.string().min(1),
  // The food as the user actually said it, for display back to the user.
  food_name_ru: z.string().min(1),
  // Amount in grams. If the user gave a count ("2 eggs") or a household
  // measure, the model estimates a reasonable gram equivalent.
  grams: z.number().positive(),
});

const ParsedResponseSchema = z.object({
  items: z.array(ParsedItemSchema),
  // Set when the audio wasn't about food at all, or was unintelligible.
  clarification_needed: z.string().nullable().optional(),
});

export type ParsedFoodItem = z.infer<typeof ParsedItemSchema>;
export type ParsedResponse = z.infer<typeof ParsedResponseSchema>;

const EXTRACT_RESPONSE_FORMAT = jsonTextFormat({
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          food_query_en: {
            type: "string",
            description:
              "Short, generic English search term for a nutrition database, e.g. 'nectarine', 'boiled egg', 'white rice'.",
          },
          food_name_ru: {
            type: "string",
            description: "The food exactly as the user named it, in Russian.",
          },
          grams: {
            type: "number",
            description: "Amount eaten, in grams. Estimate if given as a count or household measure.",
          },
        },
        required: ["food_query_en", "food_name_ru", "grams"],
      },
    },
    clarification_needed: {
      type: ["string", "null"],
      description:
        "Non-null if the message contains no identifiable food/quantity info, explaining what's unclear.",
    },
  },
  required: ["items"],
});

const EXTRACT_PROMPT = `Ты — парсер сообщений для трекера питания.
Пользователь на русском языке пишет, говорит голосом или присылает фото того, что съел,
обычно с указанием веса в граммах, например: "Я съел 120 грам нектарина и 50 грам персиков".

Извлеки из сообщения (текст, аудио или фото) каждый отдельный продукт питания. Для каждого верни:
- food_query_en: короткое, обобщённое название продукта на английском для поиска в базе данных нутриентов
  (например "nectarine", "peach", "boiled egg", "white rice", "chicken breast"). Не включай бренды,
  если пользователь их не называл и на упаковке бренд не виден.
- food_name_ru: как продукт назвал сам пользователь (по-русски). Если это фото без подписи —
  короткое русское название того, что видно (блюдо или продукт).
- grams: количество в граммах. Если названо количество в штуках или бытовых мерах (яблоко, стакан,
  ложка) — оцени вес в граммах по обычным средним значениям. На фото без указанного веса оцени
  порцию по размеру упаковки или тарелки. Если в подписи к фото указан вес — используй его,
  а не визуальную оценку.

Если в сообщении нет еды или количество совсем не разобрать — верни пустой items и заполни
clarification_needed кратким объяснением на русском.`;

export class GeminiClient {
  private ai: GoogleGenAI;
  private models: string[];

  constructor(apiKey: string, models: string[]) {
    if (models.length === 0) {
      throw new Error("Gemini model pool is empty");
    }
    this.models = [...models];
    this.ai = new GoogleGenAI({ apiKey });
  }

  /** Next call starts with the model that just worked, so we don't re-hit a depleted quota. */
  private preferModel(model: string): void {
    this.models = [model, ...this.models.filter((m) => m !== model)];
  }

  private async withModelFallback<T>(label: string, run: (model: string) => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let i = 0; i < this.models.length; i++) {
      const model = this.models[i];
      try {
        logger.info(`[pipeline] Gemini ${label} trying`, { model, attempt: i + 1, of: this.models.length });
        const result = await run(model);
        this.preferModel(model);
        logger.info(`[pipeline] Gemini ${label} ok`, { model, attempt: i + 1 });
        return result;
      } catch (err) {
        lastError = err;
        logger.warn(`[pipeline] Gemini ${label} failed`, {
          model,
          attempt: i + 1,
          of: this.models.length,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`Gemini ${label} failed on all models`);
  }

  private parseExtractResponse(raw: string, source: "voice" | "text" | "photo"): ParsedResponse {
    const parsed = ParsedResponseSchema.safeParse(JSON.parse(raw || "{}"));
    if (!parsed.success) {
      logger.error("[pipeline] Gemini extract failed validation", { source, raw, issues: parsed.error.issues });
      throw new Error("Gemini returned an unexpected shape for food extraction");
    }
    logger.info("[pipeline] Gemini extractFoodItems", { source, ...parsed.data });
    return parsed.data;
  }

  /** Sends a Telegram voice note (OGG/Opus) straight to Gemini: STT + parsing in one call. */
  async extractFoodItemsFromVoice(audio: Buffer): Promise<ParsedResponse> {
    return this.withModelFallback("extractFoodItemsFromVoice", async (model) => {
      const interaction = await this.ai.interactions.create({
        model,
        input: [
          { type: "text", text: EXTRACT_PROMPT },
          {
            type: "audio",
            data: audio.toString("base64"),
            mime_type: "audio/ogg",
          },
        ],
        response_format: EXTRACT_RESPONSE_FORMAT,
      });

      return this.parseExtractResponse(getOutputText(interaction), "voice");
    });
  }

  /** Parses a typed meal description the same way as a voice note. */
  async extractFoodItemsFromText(text: string): Promise<ParsedResponse> {
    return this.withModelFallback("extractFoodItemsFromText", async (model) => {
      const interaction = await this.ai.interactions.create({
        model,
        input: [
          { type: "text", text: EXTRACT_PROMPT },
          { type: "text", text },
        ],
        response_format: EXTRACT_RESPONSE_FORMAT,
      });

      return this.parseExtractResponse(getOutputText(interaction), "text");
    });
  }

  /** Identifies foods on a meal photo; caption grams/brands override visual guesses. */
  async extractFoodItemsFromPhoto(
    image: Buffer,
    mimeType: string,
    caption?: string
  ): Promise<ParsedResponse> {
    return this.withModelFallback("extractFoodItemsFromPhoto", async (model) => {
      const input: Interactions.Content[] = [
        { type: "text", text: EXTRACT_PROMPT },
        {
          type: "image",
          data: image.toString("base64"),
          mime_type: mimeType,
        },
      ];
      const trimmedCaption = caption?.trim();
      if (trimmedCaption) {
        input.push({ type: "text", text: trimmedCaption });
      }

      const interaction = await this.ai.interactions.create({
        model,
        input,
        response_format: EXTRACT_RESPONSE_FORMAT,
      });

      return this.parseExtractResponse(getOutputText(interaction), "photo");
    });
  }

  /**
   * For each parsed item, given a shortlist of FatSecret search candidates,
   * pick the food_id that best matches what the user actually meant
   * (plain fruit/vegetable/dish, not a random branded product, matching
   * cooking state e.g. "boiled" vs "raw" when mentioned).
   * Returns one food_id (or null if nothing is a good match) per item, in order.
   */
  async matchBestCandidates(
    items: { query: string; grams: number }[],
    candidatesByItem: FoodSearchItem[][]
  ): Promise<(string | null)[]> {
    const payload = items.map((item, i) => ({
      index: i,
      query: item.query,
      grams: item.grams,
      candidates: candidatesByItem[i].map((c) => ({
        food_id: c.food_id,
        food_name: c.food_name,
        food_type: c.food_type,
        brand_name: c.brand_name ?? null,
        food_description: c.food_description,
      })),
    }));

    const prompt = `Для каждого элемента ниже выбери food_id из его списка candidates, который лучше всего
соответствует запросу (query). Предпочитай food_type "Generic" (не брендовые продукты), если пользователь
не упоминал конкретный бренд. Если ни один кандидат не подходит - верни null.

${JSON.stringify(payload, null, 2)}`;

    const responseFormat = jsonTextFormat({
      type: "object",
      properties: {
        selections: {
          type: "array",
          items: {
            type: "object",
            properties: {
              index: { type: "integer" },
              food_id: { type: ["string", "null"] },
            },
            required: ["index", "food_id"],
          },
        },
      },
      required: ["selections"],
    });

    const interaction = await this.withModelFallback("matchBestCandidates", (model) =>
      this.ai.interactions.create({
        model,
        input: [{ type: "text", text: prompt }],
        response_format: responseFormat,
      })
    );

    const raw = JSON.parse(getOutputText(interaction) || "{}") as {
      selections?: { index: number; food_id: string | null }[];
    };

    const result: (string | null)[] = new Array(items.length).fill(null);
    for (const sel of raw.selections ?? []) {
      if (sel.index >= 0 && sel.index < result.length) {
        result[sel.index] = sel.food_id;
      }
    }
    logger.info("[pipeline] Gemini matchBestCandidates", {
      selections: raw.selections ?? [],
      chosenFoodIds: result,
    });
    return result;
  }
}
