/**
 * What stands in for a missing cover (the initials on the list card) and what asks for a generated
 * one (the image prompt). No zod here, so the client bundle can import it.
 */
import type { RecipeInput } from "./schema";
import { splitSteps } from "./steps";
import { type Course, primaryCourse } from "./tags";

const FILLER = new Set(["with", "and", "of", "the", "a", "an", "in", "on", "for", "or", "style", "to"]);

/** Up to three initials of the title's significant words: "Air-fryer crispy tofu" -> "ACT". */
export function titleInitials(title: string): string {
  const words = title
    .replace(/\([^)]*\)/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((w) => w && !FILLER.has(w.toLowerCase()));
  const initials = words.slice(0, 3).map((w) => Array.from(w)[0]!);
  return (initials.join("") || Array.from(title.trim())[0] || "?").toUpperCase();
}

/** Flux takes at most 2048 characters of prompt. */
export const MAX_PROMPT = 2048;

const CONTAINER: Readonly<Record<Course, string>> = {
  drink: "A glass",
  soup: "A bowl",
  breakfast: "A plate or small bowl",
  dessert: "A plate or small bowl",
  snack: "A plate or small bowl",
  baking: "A plate or small bowl",
  main: "A plain ceramic plate or bowl",
  side: "A plain ceramic plate or bowl",
  salad: "A plain ceramic plate or bowl",
  sauce: "A plain ceramic plate or bowl",
  basics: "A plain ceramic plate or bowl",
};

/** A step that only parks the dish ("Chill overnight.", "Let cool, then store in a jar.") says nothing about how it looks served. */
const PARKING_ONLY = /^(?:let(?: it| them)? )?(?:rest|chill|refrigerate|cool|store|freeze)\b/i;
const MENTIONS_SERVING = /\b(serv|garnish|top|sprinkle|drizzle|plate)/i;
/** Keeps room for the ingredients when the last step is a long one. */
const MAX_SERVING = 500;

function plainStep(md: string): string {
  return md
    .replace(/^\s*(?:step\s*)?\d+\s*[.):]\s*/i, "")
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function servingSentence(steps_md: string): string {
  const last = plainStep(splitSteps(steps_md).at(-1) ?? "").slice(0, MAX_SERVING);
  if (!last || (PARKING_ONLY.test(last) && !MENTIONS_SERVING.test(last))) return "";
  return ` How it is served: ${/[.!?]$/.test(last) ? last : `${last}.`}`;
}

/** The text-to-image prompt for a recipe's generated cover. Long ingredient lists are cut to fit MAX_PROMPT. */
export function coverPrompt(recipe: Pick<RecipeInput, "title" | "sections" | "steps_md" | "tags">): string {
  const course = primaryCourse(recipe.tags);
  const container = course ? CONTAINER[course] : "A plain ceramic plate or bowl";
  const head = `Realistic home-cooked photo of the finished dish "${recipe.title}". Ingredients: `;
  const tail = `.${servingSentence(recipe.steps_md)} Show only what these ingredients make, nothing extra on the plate. ${container} on a light wooden table, soft daylight, 45 degree angle. No text, no letters, no logos, no people, no hands.`;
  const items = recipe.sections.flatMap((s) => s.ingredients.map((i) => i.item)).join(", ");
  const room = MAX_PROMPT - head.length - tail.length;
  const fitted = items.length <= room ? items : items.slice(0, room).replace(/,[^,]*$/, "");
  return head + fitted + tail;
}
