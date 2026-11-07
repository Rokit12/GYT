-- The size a yacht is booked with. Clients enter it when they book: length overall, beam and draft as the
-- yacht will lie in the berth (with bowsprit, swim platform, davits or a tender on the stern). It can never
-- be smaller than the yacht's registered size. NULL means "the registered size" (older holds and bookings).
ALTER TABLE berth_holds ADD COLUMN IF NOT EXISTS loa_m   NUMERIC(6,2) CHECK (loa_m > 0);
ALTER TABLE berth_holds ADD COLUMN IF NOT EXISTS beam_m  NUMERIC(5,2) CHECK (beam_m > 0);
ALTER TABLE berth_holds ADD COLUMN IF NOT EXISTS draft_m NUMERIC(5,2) CHECK (draft_m > 0);
ALTER TABLE bookings    ADD COLUMN IF NOT EXISTS loa_m   NUMERIC(6,2) CHECK (loa_m > 0);
ALTER TABLE bookings    ADD COLUMN IF NOT EXISTS beam_m  NUMERIC(5,2) CHECK (beam_m > 0);
ALTER TABLE bookings    ADD COLUMN IF NOT EXISTS draft_m NUMERIC(5,2) CHECK (draft_m > 0);
