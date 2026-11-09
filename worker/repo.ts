/** D1 access. Rows <-> shared types. No validation here; callers pass parsed data. */
import type {
  Comment,
  CoverFocus,
  ImportRecord,
  MetricUnit,
  Rating,
  Recipe,
  RecipeInput,
  RecipeSummary,
  Section,
  ShoppingItem,
  Stars,
  Time,
  User,
} from "../shared/schema";
import { restoredContent, type Revision, type RevisionMeta, type RevisionSource } from "../shared/revisions";

type RecipeRow = {
  id: string;
  title: string;
  yield_amount: number | null;
  yield_unit: string | null;
  sections_json: string;
  steps_md: string;
  notes_md: string;
  source_url: string | null;
  tags_json: string;
  time_total_min: number | null;
  time_active_min: number | null;
  source_ref: string | null;
  cover_key: string | null;
  cover_focus_x: number | null;
  cover_focus_y: number | null;
  created_at: string;
  updated_at: string;
};

/** Who chose the focal point. An import only replaces a focus it proposed itself. */
export type FocusBy = "user" | "import";

type ShoppingRow = {
  id: string;
  item: string;
  qty: number | null;
  qty_max: number | null;
  unit: string | null;
  recipe_id: string | null;
  recipe_title: string | null;
  checked: number;
  deleted: number;
  updated_at: string;
  rev: number;
};

const nn = <T>(v: T | null): T | undefined => (v === null ? undefined : v);

const rowToFocus = (r: Pick<RecipeRow, "cover_focus_x" | "cover_focus_y">): CoverFocus | null =>
  r.cover_focus_x === null || r.cover_focus_y === null ? null : { x: r.cover_focus_x, y: r.cover_focus_y };

const rowToTime = (r: Pick<RecipeRow, "time_total_min" | "time_active_min">): Time | undefined =>
  r.time_total_min === null ? undefined : { total_min: r.time_total_min, active_min: nn(r.time_active_min) };

const ingredientItems = (sectionsJson: string): string[] => (JSON.parse(sectionsJson) as Section[]).flatMap((s) => s.ingredients.map((i) => i.item));

function rowToRecipe(r: RecipeRow, ratings: Rating[]): Recipe {
  return {
    id: r.id,
    title: r.title,
    yield: r.yield_amount !== null && r.yield_unit !== null ? { amount: r.yield_amount, unit: r.yield_unit } : undefined,
    sections: JSON.parse(r.sections_json) as Section[],
    steps_md: r.steps_md,
    notes_md: r.notes_md,
    source_url: nn(r.source_url),
    tags: JSON.parse(r.tags_json) as string[],
    time: rowToTime(r),
    cover_key: nn(r.cover_key),
    cover_focus: rowToFocus(r),
    source_ref: nn(r.source_ref),
    ratings,
    updated_at: r.updated_at,
  };
}

function rowToShopping(r: ShoppingRow): ShoppingItem {
  return {
    id: r.id,
    item: r.item,
    qty: nn(r.qty),
    qtyMax: nn(r.qty_max),
    unit: nn(r.unit) as MetricUnit | undefined,
    recipe_id: nn(r.recipe_id),
    recipe_title: nn(r.recipe_title),
    checked: r.checked === 1,
    deleted: r.deleted === 1 ? true : undefined,
    updated_at: r.updated_at,
  };
}

export async function listRecipes(db: D1Database): Promise<RecipeSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT r.id, r.title, r.tags_json, r.sections_json, r.notes_md, r.yield_amount, r.yield_unit, r.time_total_min, r.time_active_min, r.cover_key, r.cover_focus_x, r.cover_focus_y, r.created_at, r.updated_at,
              AVG(g.stars) AS avg_rating, COUNT(g.stars) AS rating_count
         FROM recipes r LEFT JOIN ratings g ON g.recipe_id = r.id
        GROUP BY r.id ORDER BY r.title COLLATE NOCASE`,
    )
    .all<RecipeRow & { avg_rating: number | null; rating_count: number }>();
  return results.map((r) => ({
    id: r.id,
    title: r.title,
    tags: JSON.parse(r.tags_json) as string[],
    ingredients: ingredientItems(r.sections_json),
    notes_md: r.notes_md,
    yield: r.yield_amount !== null && r.yield_unit !== null ? { amount: r.yield_amount, unit: r.yield_unit } : undefined,
    time: rowToTime(r),
    cover_key: nn(r.cover_key),
    cover_focus: rowToFocus(r),
    avg_rating: r.avg_rating === null ? null : Math.round(r.avg_rating * 10) / 10,
    rating_count: r.rating_count,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
}

export async function getRecipe(db: D1Database, id: string): Promise<Recipe | null> {
  const [rec, rat] = await db.batch([
    db.prepare("SELECT * FROM recipes WHERE id = ?").bind(id),
    db.prepare("SELECT user, stars FROM ratings WHERE recipe_id = ? ORDER BY user").bind(id),
  ]);
  const row = (rec!.results as RecipeRow[])[0];
  if (!row) return null;
  return rowToRecipe(row, rat!.results as Rating[]);
}

export async function listComments(db: D1Database, recipeId: string): Promise<Comment[]> {
  const { results } = await db
    .prepare("SELECT * FROM comments WHERE recipe_id = ? ORDER BY created_at")
    .bind(recipeId)
    .all<Comment>();
  return results;
}

/** With `expectedUpdatedAt`, an existing row is only updated while its updated_at still equals it. */
function upsertRecipeStmt(db: D1Database, id: string, input: RecipeInput, now: string, expectedUpdatedAt?: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO recipes (id, title, yield_amount, yield_unit, sections_json, steps_md, notes_md, source_url, tags_json,
                            time_total_min, time_active_min, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)
       ON CONFLICT(id) DO UPDATE SET title=excluded.title, yield_amount=excluded.yield_amount, yield_unit=excluded.yield_unit,
         sections_json=excluded.sections_json, steps_md=excluded.steps_md, notes_md=excluded.notes_md,
         source_url=excluded.source_url, tags_json=excluded.tags_json, time_total_min=excluded.time_total_min,
         time_active_min=excluded.time_active_min, updated_at=excluded.updated_at
       WHERE ?13 IS NULL OR recipes.updated_at = ?13`,
    )
    .bind(
      id,
      input.title,
      input.yield?.amount ?? null,
      input.yield?.unit ?? null,
      JSON.stringify(input.sections),
      input.steps_md,
      input.notes_md,
      input.source_url ?? null,
      JSON.stringify(input.tags),
      input.time?.total_min ?? null,
      input.time?.active_min ?? null,
      now,
      expectedUpdatedAt ?? null,
    );
}

/** False when `expectedUpdatedAt` is given and the row changed since (nothing is written then). */
export async function upsertRecipe(db: D1Database, id: string, input: RecipeInput, change: ContentChange, expectedUpdatedAt?: string): Promise<boolean> {
  const [res] = await writeContent(db, id, change, [upsertRecipeStmt(db, id, input, change.now, expectedUpdatedAt)]);
  return res!.meta.changes === 1;
}

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "recipe";
}

/** A readable id from the title, with a random suffix when it is taken. */
export async function freshRecipeId(db: D1Database, title: string): Promise<string> {
  const id = slugify(title);
  return (await recipeExists(db, id)) ? `${id}-${crypto.randomUUID().slice(0, 8)}` : id;
}

/** What search and the duplicate guard need for every recipe, in one round trip. */
export type IndexedRecipe = {
  id: string;
  title: string;
  tags: string[];
  total_min?: number;
  source_url?: string;
  has_cover: boolean;
  ingredients: string[];
  notes_md: string;
  ratings: Rating[];
};

export async function recipeIndex(db: D1Database): Promise<IndexedRecipe[]> {
  const [rec, rat] = await db.batch([
    db.prepare("SELECT id, title, tags_json, time_total_min, source_url, cover_key, sections_json, notes_md FROM recipes ORDER BY title COLLATE NOCASE"),
    db.prepare("SELECT recipe_id, user, stars FROM ratings ORDER BY user"),
  ]);
  const ratings = new Map<string, Rating[]>();
  for (const r of rat!.results as (Rating & { recipe_id: string })[]) {
    ratings.set(r.recipe_id, [...(ratings.get(r.recipe_id) ?? []), { user: r.user, stars: r.stars }]);
  }
  return (rec!.results as RecipeRow[]).map((r) => ({
    id: r.id,
    title: r.title,
    tags: JSON.parse(r.tags_json) as string[],
    total_min: nn(r.time_total_min),
    source_url: nn(r.source_url),
    has_cover: r.cover_key !== null,
    ingredients: ingredientItems(r.sections_json),
    notes_md: r.notes_md,
    ratings: ratings.get(r.id) ?? [],
  }));
}

// ---------- revisions ----------
/** Who changed a recipe's content, how, and when. Every content write takes one. */
export type ContentChange = { author: User; source: Exclude<RevisionSource, "baseline" | "migration">; now: string };

/** The recipes row's content as snapshot JSON, built in SQL so it is exactly what the batch wrote. */
const SNAPSHOT = `json_object('title', title,
  'yield', json(CASE WHEN yield_amount IS NULL THEN NULL ELSE json_object('amount', yield_amount, 'unit', yield_unit) END),
  'time', json(CASE WHEN time_total_min IS NULL THEN NULL ELSE json_object('total_min', time_total_min, 'active_min', time_active_min) END),
  'sections', json(sections_json), 'steps_md', steps_md, 'notes_md', notes_md, 'source_url', source_url, 'tags', json(tags_json))`;
const LATEST = "(SELECT MAX(id) FROM recipe_revisions WHERE recipe_id = ?1)";
const TAG_COALESCE_MS = 10 * 60 * 1000;

/**
 * The one place revisions are written. Runs the statements that change a recipe's content in one
 * batch (one transaction) that also records the content after the change, and returns their results:
 * - a recipe's first change records its prior content first, as 'baseline' (dropped again if nothing changed),
 * - content equal to the latest revision records nothing,
 * - tags by the same user within 10 minutes of their 'tags' revision, when it is still the latest,
 *   update it in place (and drop it if that undoes it).
 */
async function writeContent(db: D1Database, id: string, change: ContentChange, stmts: D1PreparedStatement[]): Promise<D1Result[]> {
  const s = (sql: string, ...params: (string | null)[]): D1PreparedStatement => db.prepare(sql).bind(id, ...params);
  const out = [
    s(`INSERT INTO recipe_revisions (recipe_id, snapshot, author, source, created_at)
       SELECT id, ${SNAPSHOT}, NULL, 'baseline', updated_at FROM recipes
        WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM recipe_revisions WHERE recipe_id = ?1)`),
    ...stmts,
  ];
  if (change.source === "tags") {
    const cutoff = new Date(Date.parse(change.now) - TAG_COALESCE_MS).toISOString();
    out.push(
      s(
        `UPDATE recipe_revisions SET snapshot = (SELECT ${SNAPSHOT} FROM recipes WHERE id = ?1), created_at = ?3
          WHERE id = ${LATEST} AND source = 'tags' AND author = ?2 AND created_at > ?4`,
        change.author,
        change.now,
        cutoff,
      ),
      s(`DELETE FROM recipe_revisions WHERE id = ${LATEST} AND snapshot =
           (SELECT snapshot FROM recipe_revisions WHERE recipe_id = ?1 AND id < ${LATEST} ORDER BY id DESC LIMIT 1)`),
    );
  }
  out.push(
    s(
      `INSERT INTO recipe_revisions (recipe_id, snapshot, author, source, created_at)
       SELECT id, ${SNAPSHOT}, ?2, ?3, ?4 FROM recipes
        WHERE id = ?1 AND ${SNAPSHOT} IS NOT (SELECT snapshot FROM recipe_revisions WHERE id = ${LATEST})`,
      change.author,
      change.source,
      change.now,
    ),
    s(`DELETE FROM recipe_revisions WHERE recipe_id = ?1 AND source = 'baseline'
        AND NOT EXISTS (SELECT 1 FROM recipe_revisions WHERE recipe_id = ?1 AND source <> 'baseline')`),
  );
  return (await db.batch(out)).slice(1, 1 + stmts.length);
}

type RevisionRow = RevisionMeta & { snapshot: string };

type SnapshotJson = Omit<RecipeInput, "yield" | "time" | "source_url"> & {
  yield: RecipeInput["yield"] | null;
  time: { total_min: number; active_min: number | null } | null;
  source_url: string | null;
};

function rowToRevision(r: RevisionRow): Revision {
  const j = JSON.parse(r.snapshot) as SnapshotJson;
  return {
    id: r.id,
    author: r.author,
    source: r.source,
    created_at: r.created_at,
    snapshot: {
      title: j.title,
      yield: nn(j.yield),
      time: j.time ? { total_min: j.time.total_min, active_min: nn(j.time.active_min) } : undefined,
      sections: j.sections,
      steps_md: j.steps_md,
      notes_md: j.notes_md,
      source_url: nn(j.source_url),
      tags: j.tags,
    },
  };
}

/** Oldest first. The newest one is the current content. */
export async function listRevisions(db: D1Database, recipeId: string): Promise<Revision[]> {
  const { results } = await db
    .prepare("SELECT id, author, source, created_at, snapshot FROM recipe_revisions WHERE recipe_id = ? ORDER BY id")
    .bind(recipeId)
    .all<RevisionRow>();
  return results.map(rowToRevision);
}

export async function getRevision(db: D1Database, recipeId: string, rev: number): Promise<Revision | null> {
  const row = await db
    .prepare("SELECT id, author, source, created_at, snapshot FROM recipe_revisions WHERE recipe_id = ? AND id = ?")
    .bind(recipeId, rev)
    .first<RevisionRow>();
  return row ? rowToRevision(row) : null;
}

export type ImportedRow = { id: string; import_hash: string | null; cover_key: string | null };

export async function findBySourceRef(db: D1Database, sourceRef: string): Promise<ImportedRow | null> {
  return db.prepare("SELECT id, import_hash, cover_key FROM recipes WHERE source_ref = ?").bind(sourceRef).first<ImportedRow>();
}

/** An imported comment's id is derived from where it came from, so re-importing it updates instead of duplicating. */
export type ImportedComment = { id: string; user: User; body_md: string; created_at: string };

/**
 * Write one import record in a single batch (one transaction): recipe content, the source link
 * and record hash, per-user ratings, and comments upserted by their derived id.
 * Ratings and comments that exist only in the app are left alone, and so is a focus the user set.
 */
export async function applyImport(
  db: D1Database,
  id: string,
  rec: ImportRecord,
  comments: readonly ImportedComment[],
  hash: string,
  change: ContentChange,
): Promise<void> {
  const { now } = change;
  const rating = db.prepare(
    `INSERT INTO ratings (recipe_id, user, stars, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(recipe_id, user) DO UPDATE SET stars = excluded.stars, updated_at = excluded.updated_at
     WHERE ratings.stars <> excluded.stars`,
  );
  const comment = db.prepare(
    `INSERT INTO comments (id, recipe_id, user, body_md, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET body_md = excluded.body_md, updated_at = excluded.updated_at
     WHERE comments.body_md <> excluded.body_md`,
  );
  await writeContent(db, id, change, [
    upsertRecipeStmt(db, id, rec.recipe, now),
    db.prepare("UPDATE recipes SET source_ref = ?, import_hash = ? WHERE id = ?").bind(rec.source_ref, hash, id),
    db
      .prepare("UPDATE recipes SET cover_focus_x = ?, cover_focus_y = ?, cover_focus_by = ? WHERE id = ? AND cover_focus_by IS NOT 'user'")
      .bind(rec.cover_focus?.x ?? null, rec.cover_focus?.y ?? null, rec.cover_focus ? "import" : null, id),
    ...rec.ratings.map((r) => rating.bind(id, r.user, r.stars, now)),
    ...comments.map((c) => comment.bind(c.id, id, c.user, c.body_md, c.created_at, now)),
  ]);
}

/** Writes the revision's content and tags as current (see `restoredContent`). False if there is no such revision. Already current: records nothing. */
export async function restoreRevision(db: D1Database, id: string, rev: number, change: ContentChange): Promise<boolean> {
  const revision = await getRevision(db, id, rev);
  if (!revision) return false;
  await upsertRecipe(db, id, restoredContent(revision.snapshot), change);
  return true;
}

export async function getCoverKey(db: D1Database, id: string): Promise<{ cover_key: string | null } | null> {
  return db.prepare("SELECT cover_key FROM recipes WHERE id = ?").bind(id).first<{ cover_key: string | null }>();
}

/** A new image starts with the focus that came with it (the importer's proposal), or none. */
export async function setCoverKey(db: D1Database, id: string, key: string, focus: CoverFocus | null, now: string): Promise<void> {
  await db
    .prepare("UPDATE recipes SET cover_key = ?, cover_focus_x = ?, cover_focus_y = ?, cover_focus_by = ?, updated_at = ? WHERE id = ?")
    .bind(key, focus?.x ?? null, focus?.y ?? null, focus ? "import" : null, now, id)
    .run();
}

/** Returns false if the recipe does not exist. */
export async function setCoverFocus(db: D1Database, id: string, focus: CoverFocus | null, by: FocusBy, now: string): Promise<boolean> {
  const res = await db
    .prepare("UPDATE recipes SET cover_focus_x = ?, cover_focus_y = ?, cover_focus_by = ?, updated_at = ? WHERE id = ?")
    .bind(focus?.x ?? null, focus?.y ?? null, by, now, id)
    .run();
  return res.meta.changes === 1;
}

export async function recipeExists(db: D1Database, id: string): Promise<boolean> {
  return (await db.prepare("SELECT 1 FROM recipes WHERE id = ?").bind(id).first()) !== null;
}

/**
 * Read-modify-write of the tag list with compare-and-swap on the old JSON, retried, so two
 * concurrent PATCHes cannot overwrite each other. Returns the new tags, or null if the recipe is gone.
 */
export async function updateTags(
  db: D1Database,
  id: string,
  edit: (tags: string[]) => string[],
  change: ContentChange,
): Promise<string[] | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await db.prepare("SELECT tags_json FROM recipes WHERE id = ?").bind(id).first<{ tags_json: string }>();
    if (!row) return null;
    const next = edit(JSON.parse(row.tags_json) as string[]);
    const nextJson = JSON.stringify(next);
    if (nextJson === row.tags_json) return next; // no-op delta
    const cas = db
      .prepare("UPDATE recipes SET tags_json = ?, updated_at = ? WHERE id = ? AND tags_json = ?")
      .bind(nextJson, change.now, id, row.tags_json);
    const [res] = await writeContent(db, id, change, [cas]);
    if (res!.meta.changes === 1) return next;
  }
  throw new Error("tag update kept conflicting, try again");
}

export async function setRating(db: D1Database, recipeId: string, user: User, stars: Stars, now: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ratings (recipe_id, user, stars, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(recipe_id, user) DO UPDATE SET stars = excluded.stars, updated_at = excluded.updated_at`,
    )
    .bind(recipeId, user, stars, now)
    .run();
}

export async function getComment(db: D1Database, id: string): Promise<Comment | null> {
  return db.prepare("SELECT * FROM comments WHERE id = ?").bind(id).first<Comment>();
}

export async function putComment(db: D1Database, c: Comment): Promise<void> {
  await db
    .prepare(
      `INSERT INTO comments (id, recipe_id, user, body_md, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET body_md = excluded.body_md, updated_at = excluded.updated_at`,
    )
    .bind(c.id, c.recipe_id, c.user, c.body_md, c.created_at, c.updated_at)
    .run();
}

export async function deleteComment(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM comments WHERE id = ?").bind(id).run();
}

/**
 * Apply client rows with last-write-wins on updated_at. Each accepted write
 * gets rev = max(rev)+1 so pollers can ask for "everything after rev N".
 * D1 runs a batch as one transaction, so revs stay strictly increasing.
 */
export async function applyShopping(db: D1Database, items: readonly ShoppingItem[]): Promise<void> {
  if (items.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO shopping_items (id, item, qty, qty_max, unit, recipe_id, recipe_title, checked, deleted, updated_at, rev)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(rev), 0) + 1 FROM shopping_items))
     ON CONFLICT(id) DO UPDATE SET item=excluded.item, qty=excluded.qty, qty_max=excluded.qty_max, unit=excluded.unit,
       recipe_id=excluded.recipe_id, recipe_title=excluded.recipe_title, checked=excluded.checked,
       deleted=excluded.deleted, updated_at=excluded.updated_at, rev=excluded.rev
     WHERE excluded.updated_at > shopping_items.updated_at`,
  );
  await db.batch(
    items.map((i) =>
      stmt.bind(
        i.id,
        i.item,
        i.qty ?? null,
        i.qtyMax ?? null,
        i.unit ?? null,
        i.recipe_id ?? null,
        i.recipe_title ?? null,
        i.checked ? 1 : 0,
        i.deleted ? 1 : 0,
        i.updated_at,
      ),
    ),
  );
}

export async function shoppingSince(db: D1Database, since: number): Promise<{ items: ShoppingItem[]; rev: number }> {
  const [rows, max] = await db.batch([
    db.prepare("SELECT * FROM shopping_items WHERE rev > ? ORDER BY rev").bind(since),
    db.prepare("SELECT COALESCE(MAX(rev), 0) AS rev FROM shopping_items"),
  ]);
  return {
    items: (rows!.results as ShoppingRow[]).map(rowToShopping),
    rev: (max!.results as { rev: number }[])[0]!.rev,
  };
}

export async function getShopping(db: D1Database, id: string): Promise<ShoppingItem | null> {
  const row = await db.prepare("SELECT * FROM shopping_items WHERE id = ?").bind(id).first<ShoppingRow>();
  return row ? rowToShopping(row) : null;
}

// ---------- import from a link: rate limit, token usage, AI availability ----------
/** Imports by `user` after `since`, and the oldest of them (to say when the next one is allowed). */
export async function urlImportsSince(db: D1Database, user: User, since: string): Promise<{ count: number; oldest: string | null }> {
  const row = await db
    .prepare("SELECT COUNT(*) AS count, MIN(created_at) AS oldest FROM url_import_log WHERE user = ? AND created_at > ?")
    .bind(user, since)
    .first<{ count: number; oldest: string | null }>();
  return row ?? { count: 0, oldest: null };
}

/** Logs the attempt and returns its row id, for recordUrlImportUsage. */
export async function logUrlImport(db: D1Database, user: User, now: string, pruneBefore: string): Promise<number> {
  await db.prepare("DELETE FROM url_import_log WHERE created_at < ?").bind(pruneBefore).run();
  const row = await db.prepare("INSERT INTO url_import_log (user, created_at) VALUES (?, ?) RETURNING id").bind(user, now).first<{ id: number }>();
  return row!.id;
}

export type TokenUsage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };

export async function recordUrlImportUsage(db: D1Database, logId: number, model: string, usage: readonly TokenUsage[]): Promise<void> {
  const total = (k: keyof TokenUsage): number => usage.reduce((s, u) => s + u[k], 0);
  await db
    .prepare("UPDATE url_import_log SET model = ?, input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ? WHERE id = ?")
    .bind(model, total("input_tokens"), total("output_tokens"), total("cache_read_input_tokens"), total("cache_creation_input_tokens"), logId)
    .run();
}

export type UsageTotals = { imports: number; model_imports: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number };

export async function urlImportUsageSince(db: D1Database, since: string): Promise<UsageTotals> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS imports, COUNT(model) AS model_imports, COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens, COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens
       FROM url_import_log WHERE created_at > ?`,
    )
    .bind(since)
    .first<UsageTotals>();
  return row!;
}

export type AiOutage = { reason: "credits_exhausted" | "key_rejected"; until: string };

export async function getAiOutage(db: D1Database, now: string): Promise<AiOutage | null> {
  return db.prepare("SELECT reason, until FROM ai_status WHERE key = 'anthropic' AND until > ?").bind(now).first<AiOutage>();
}

export async function setAiOutage(db: D1Database, outage: AiOutage): Promise<void> {
  await db
    .prepare("INSERT INTO ai_status (key, reason, until) VALUES ('anthropic', ?1, ?2) ON CONFLICT(key) DO UPDATE SET reason = ?1, until = ?2")
    .bind(outage.reason, outage.until)
    .run();
}
