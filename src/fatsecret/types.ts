export interface FoodSearchItem {
  food_id: string;
  food_name: string;
  food_type: string; // "Generic" | "Brand"
  brand_name?: string;
  food_description: string; // e.g. "Per 100g - Calories: 39kcal | Fat: 0.30g | ..."
}

export interface FoodSearchResponse {
  foods?: {
    food?: FoodSearchItem | FoodSearchItem[];
    total_results?: string;
    max_results?: string;
    page_number?: string;
  };
}

export interface FoodServing {
  serving_id: string;
  serving_description: string; // e.g. "100 g", "1 cup"
  metric_serving_amount?: string; // e.g. "100.000"
  metric_serving_unit?: string; // e.g. "g"
  number_of_units?: string;
  measurement_description?: string;
  calories?: string;
  protein?: string;
  carbohydrate?: string;
  fat?: string;
}

export interface FoodGetResponse {
  food?: {
    food_id: string;
    food_name: string;
    food_type?: string;
    brand_name?: string;
    servings?: {
      serving?: FoodServing | FoodServing[];
    };
  };
}

export interface FoodEntryCreateResponse {
  food_entry_id?: {
    value?: string;
  };
  error?: {
    code: string;
    message: string;
  };
}
