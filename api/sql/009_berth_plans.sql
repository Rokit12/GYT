-- A marina's own berth plan: the image an admin imported, its real size, and where each berth sits on it,
-- so the 3D marina is built from the marina's actual layout instead of a generated row.
CREATE TABLE IF NOT EXISTS marina_plans (
    marina_id   TEXT PRIMARY KEY REFERENCES marinas(id) ON DELETE CASCADE,
    mime        TEXT,
    data        BYTEA,
    sha256      TEXT,
    width_m     NUMERIC(8,2) NOT NULL CHECK (width_m > 0),
    height_m    NUMERIC(8,2) NOT NULL CHECK (height_m > 0),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by  INTEGER REFERENCES users(id)
);

-- Where a berth is on its marina's plan: the centre of its pontoon end, in metres from the plan's centre
-- (x to the right, z down the image), and the direction it runs from the pontoon (radians, 0 = down).
ALTER TABLE berths ADD COLUMN IF NOT EXISTS plan_x_m NUMERIC(8,2);
ALTER TABLE berths ADD COLUMN IF NOT EXISTS plan_z_m NUMERIC(8,2);
ALTER TABLE berths ADD COLUMN IF NOT EXISTS plan_rot NUMERIC(7,4);
