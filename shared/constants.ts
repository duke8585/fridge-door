/** Plain constants with no zod import, so the client bundle can use them without pulling in zod. */
export const METRIC_UNITS = ["g", "kg", "ml", "l", "tsp", "tbsp", "piece", "clove"] as const;
export const USERS = ["max", "partner"] as const;
