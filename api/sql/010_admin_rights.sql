-- Admin rights. One PRIMARY admin holds every right and can never be deleted, suspended or demoted;
-- only the primary admin adds secondary admins and chooses which rights each one has.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_rights TEXT[];

-- at most one primary admin
CREATE UNIQUE INDEX IF NOT EXISTS users_one_primary_admin ON users ((is_primary)) WHERE is_primary;

-- the first admin becomes primary; admins that already exist keep every right until the primary changes them
UPDATE users SET is_primary = TRUE
 WHERE id = (SELECT id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id LIMIT 1)
   AND NOT EXISTS (SELECT 1 FROM users WHERE is_primary);
UPDATE users SET admin_rights = ARRAY['autopilot','monitoring','registry','users','investors','banking','berths','bookings','audit','docs']
 WHERE role = 'admin' AND NOT is_primary AND admin_rights IS NULL;

-- the database itself protects the primary admin, whatever code path tries
CREATE OR REPLACE FUNCTION protect_primary_admin() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_primary THEN
      RAISE EXCEPTION 'The primary admin cannot be deleted' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.is_primary AND (NOT NEW.is_primary OR NEW.role <> 'admin' OR NEW.status <> 'active') THEN
    RAISE EXCEPTION 'The primary admin keeps every right and cannot be suspended or demoted' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.is_primary AND NOT OLD.is_primary THEN
    RAISE EXCEPTION 'There is already a primary admin' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_protect_primary ON users;
CREATE TRIGGER users_protect_primary BEFORE UPDATE OR DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION protect_primary_admin();
