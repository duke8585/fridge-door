/**
 * What a recipe page offers before any model sees it: schema.org Recipe data (JSON-LD) when the
 * page has it, otherwise its readable main text, plus the og: metadata for titles and covers.
 * Regex-based on purpose: it runs in the Worker and in node tests alike, and only needs text.
 */
export const MAX_TEXT_CHARS = 30_000;
/** Less readable text than this is treated as "no recipe text" (login walls, video pages). */
export const MIN_TEXT_CHARS = 400;

export type PageMeta = { title?: string; description?: string; image?: string; siteName?: string };
export type Extraction =
  | { kind: "json-ld"; text: string; recipe: JsonObject; meta: PageMeta }
  | { kind: "text"; text: string; meta: PageMeta }
  | { kind: "none"; meta: PageMeta };

export function extractPage(html: string, pageUrl: string): Extraction {
  const meta = pageMeta(html, pageUrl);
  const ld = findJsonLdRecipe(html);
  if (ld) {
    const image = meta.image ?? absoluteHttps(firstImage(ld.image), pageUrl);
    return { kind: "json-ld", text: recipeLdToText(ld), recipe: ld, meta: { ...meta, image } };
  }
  const text = readableText(html);
  return text.length >= MIN_TEXT_CHARS ? { kind: "text", text, meta } : { kind: "none", meta };
}

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };

const isObject = (v: Json | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const asArray = (v: Json | undefined): Json[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const hasType = (o: JsonObject, type: string): boolean => asArray(o["@type"]).some((t) => typeof t === "string" && t.toLowerCase() === type.toLowerCase());

/** The first schema.org Recipe in any ld+json block, looking through arrays and @graph. */
export function findJsonLdRecipe(html: string): JsonObject | undefined {
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: Json;
    try {
      data = JSON.parse(m[1]!.trim().replace(/^<!--|-->$/g, "")) as Json;
    } catch {
      continue;
    }
    const found = findRecipe(data, 0);
    if (found) return found;
  }
  return undefined;
}

function findRecipe(node: Json, depth: number): JsonObject | undefined {
  if (depth > 6) return undefined;
  if (Array.isArray(node)) {
    for (const n of node) {
      const r = findRecipe(n, depth + 1);
      if (r) return r;
    }
    return undefined;
  }
  if (!isObject(node)) return undefined;
  if (hasType(node, "Recipe")) return node;
  for (const key of ["@graph", "mainEntity", "mainEntityOfPage", "itemListElement", "item"]) {
    const r = node[key] === undefined ? undefined : findRecipe(node[key]!, depth + 1);
    if (r) return r;
  }
  return undefined;
}

export const str = (v: Json | undefined): string | undefined => {
  if (typeof v === "string") return clean(v) || undefined;
  if (typeof v === "number") return String(v);
  if (isObject(v)) return str(v.name) ?? str(v.text) ?? str(v["@value"]);
  return undefined;
};
export const strs = (v: Json | undefined): string[] =>
  asArray(v)
    .map(str)
    .filter((s): s is string => !!s);

/** A compact plain-text rendering of the Recipe object, the model's input on the JSON-LD path. */
export function recipeLdToText(ld: JsonObject): string {
  const lines: string[] = [];
  const field = (label: string, v: string | undefined): void => {
    if (v) lines.push(`${label}: ${v}`);
  };
  field("Title", str(ld.name));
  field("Description", str(ld.description));
  field("Author", strs(ld.author).join(", ") || undefined);
  field("Yield", strs(ld.recipeYield).join(" / ") || undefined);
  field("Prep time", str(ld.prepTime));
  field("Cook time", str(ld.cookTime));
  field("Total time", str(ld.totalTime));
  field("Category", strs(ld.recipeCategory).join(", ") || undefined);
  field("Cuisine", strs(ld.recipeCuisine).join(", ") || undefined);
  field("Keywords", strs(ld.keywords).join(", ") || undefined);
  const ingredients = strs(ld.recipeIngredient ?? ld.ingredients);
  if (ingredients.length) lines.push("", "Ingredients:", ...ingredients.map((i) => `- ${i}`));
  const steps = instructionSteps(ld.recipeInstructions);
  if (steps.length) {
    lines.push("", "Instructions:");
    let section: string | undefined;
    steps.forEach((step, i) => {
      if (step.section && step.section !== section) lines.push(`${step.section}:`);
      section = step.section;
      lines.push(`${i + 1}. ${step.text}`);
    });
  }
  const notes = strs(ld.recipeNotes ?? ld.notes);
  if (notes.length) lines.push("", "Notes:", ...notes.map((n) => `- ${n}`));
  return lines.join("\n").slice(0, MAX_TEXT_CHARS);
}

export type InstructionStep = { section?: string; text: string };

/** HowToStep, HowToSection (its name kept per step), plain strings, or one HTML string. */
export function instructionSteps(v: Json | undefined): InstructionStep[] {
  if (typeof v === "string")
    return htmlToText(v)
      .split("\n")
      .filter(Boolean)
      .map((text) => ({ text }));
  const out: InstructionStep[] = [];
  const walk = (node: Json, section: string | undefined): void => {
    if (typeof node === "string") {
      const text = clean(node);
      if (text) out.push({ section, text });
      return;
    }
    if (Array.isArray(node)) return node.forEach((n) => walk(n, section));
    if (!isObject(node)) return;
    if (hasType(node, "HowToSection") || (node.itemListElement !== undefined && !hasType(node, "HowToStep"))) {
      const name = str(node.name);
      return asArray(node.itemListElement).forEach((n) => walk(n, name ?? section));
    }
    const text = str(node.text) ?? str(node.name);
    if (text) out.push({ section, text });
  };
  walk(v ?? [], undefined);
  return out;
}

function firstImage(v: Json | undefined): string | undefined {
  for (const i of asArray(v)) {
    if (typeof i === "string") return i;
    if (isObject(i) && typeof i.url === "string") return i.url;
  }
  return undefined;
}

/** og:/twitter: metadata and <title>. Attribute order does not matter. */
export function pageMeta(html: string, pageUrl: string): PageMeta {
  const metas = new Map<string, string>();
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const key = attr(tag, "property") ?? attr(tag, "name");
    const content = attr(tag, "content");
    if (key && content && !metas.has(key.toLowerCase())) metas.set(key.toLowerCase(), clean(content));
  }
  const titleTag = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return {
    title: metas.get("og:title") || metas.get("twitter:title") || (titleTag ? clean(titleTag) : undefined) || undefined,
    description: metas.get("og:description") || metas.get("description") || undefined,
    image: absoluteHttps(metas.get("og:image") || metas.get("og:image:url") || metas.get("twitter:image"), pageUrl),
    siteName: metas.get("og:site_name") || undefined,
  };
}

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

/** Only https covers: the cover download refuses anything else. */
function absoluteHttps(raw: string | undefined, base: string): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(decodeEntities(raw), base);
    return url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

const DROP_BLOCKS = ["script", "style", "noscript", "svg", "template", "iframe", "nav", "header", "footer", "aside", "form", "button", "select", "figure"];

/** The page as plain text: <article> or <main> when it has one, without chrome; capped. */
export function readableText(html: string): string {
  let body = html.replace(/<!--[\s\S]*?-->/g, "");
  for (const tag of DROP_BLOCKS) body = body.replace(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}\\s*>`, "gi"), " ");
  const main = largest(body, "article") ?? largest(body, "main");
  const text = htmlToText(main && htmlToText(main).length >= MIN_TEXT_CHARS ? main : body);
  return text.slice(0, MAX_TEXT_CHARS);
}

function largest(html: string, tag: string): string | undefined {
  let best: string | undefined;
  for (const m of html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}\\s*>`, "gi"))) if (!best || m[1]!.length > best.length) best = m[1];
  return best;
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(br|hr)\b[^>]*>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<\/?(p|div|section|h[1-6]|ul|ol|li|tr|table|blockquote|dd|dt)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter((l) => l && l !== "-")
    .join("\n");
}

const clean = (s: string): string =>
  htmlToText(s)
    .replace(/\s*\n\s*/g, " ")
    .trim();

const NAMED: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "-",
  mdash: "-",
  hellip: "...",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  deg: "°",
  times: "x",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (all, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    }
    return NAMED[e.toLowerCase()] ?? all;
  });
}
