-- Focal point of the cover in percent of the image (CSS object-position). NULL = the app default.
ALTER TABLE recipes ADD COLUMN cover_focus_x REAL CHECK (cover_focus_x BETWEEN 0 AND 100);
ALTER TABLE recipes ADD COLUMN cover_focus_y REAL CHECK (cover_focus_y BETWEEN 0 AND 100);
-- 'user': set in the editor, an import never overwrites it. 'import': a proposal the next changed
-- import record may replace. NULL: nobody chose (default, or reset by a new cover image).
ALTER TABLE recipes ADD COLUMN cover_focus_by TEXT CHECK (cover_focus_by IN ('user', 'import'));
