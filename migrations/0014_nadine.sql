-- OR IGNORE + DELETE: a row nadine wrote after the new worker went live wins over her old partner row.
UPDATE OR IGNORE ratings SET user = 'nadine' WHERE user = 'partner';
DELETE FROM ratings WHERE user = 'partner';
UPDATE comments SET user = 'nadine' WHERE user = 'partner';
UPDATE OR IGNORE bookmarks SET user = 'nadine' WHERE user = 'partner';
DELETE FROM bookmarks WHERE user = 'partner';
UPDATE url_import_log SET user = 'nadine' WHERE user = 'partner';
UPDATE recipe_revisions SET author = 'nadine' WHERE author = 'partner';
