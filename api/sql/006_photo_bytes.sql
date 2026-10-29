-- Keep photo bytes in the database (PHOTO_STORAGE=db, the default) so every piece of state lives in
-- the always-on database and API containers can be replaced freely. stored_name stays for disk mode.
ALTER TABLE yacht_photos ADD COLUMN IF NOT EXISTS data BYTEA;
