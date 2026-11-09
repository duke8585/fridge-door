-- Total and hands-on time in minutes (both NULL when unknown).
ALTER TABLE recipes ADD COLUMN time_total_min INTEGER;
ALTER TABLE recipes ADD COLUMN time_active_min INTEGER;
-- Imported recipes: "asana:<gid>", and a hash of the last applied import record so an
-- unchanged re-run writes nothing (and does not undo edits made in the app since).
ALTER TABLE recipes ADD COLUMN source_ref TEXT;
ALTER TABLE recipes ADD COLUMN import_hash TEXT;
-- R2 key "covers/<recipe id>/<content hash>.<ext>".
ALTER TABLE recipes ADD COLUMN cover_key TEXT;
CREATE UNIQUE INDEX recipes_source_ref ON recipes(source_ref);
