/** Plain constants with no zod import, so the client bundle can use them without pulling in zod. */
export const METRIC_UNITS = ["g", "kg", "ml", "l", "tsp", "tbsp", "piece", "clove"] as const;
/** User ids are the keys of LOGINS (wrangler.jsonc). No dots: the session cookie uses them as separators. */
export const USER_ID_PATTERN = "[a-z][a-z0-9-]{0,31}";
