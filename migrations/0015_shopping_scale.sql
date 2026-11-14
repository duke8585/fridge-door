-- The scale factor a recipe line was added with (2 for a doubled recipe). NULL means 1 and for hand-typed items.
ALTER TABLE shopping_items ADD COLUMN scale REAL;
