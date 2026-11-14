-- The second user's id is now 'nadine' instead of 'partner' (USERS in shared/constants.ts).
UPDATE ratings SET user = 'nadine' WHERE user = 'partner';
UPDATE comments SET user = 'nadine' WHERE user = 'partner';
UPDATE bookmarks SET user = 'nadine' WHERE user = 'partner';
UPDATE url_import_log SET user = 'nadine' WHERE user = 'partner';
UPDATE recipe_revisions SET author = 'nadine' WHERE author = 'partner';
