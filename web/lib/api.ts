// Server components call the API directly; client components go through /api/gyt or /api/admin,
// which forward to the API (the admin proxy adds the admin token server-side).

const API_URL = process.env.API_URL ?? "http://localhost:8000";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API_URL}${path}`, { cache: "no-store", ...init });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

export async function call<T>(path: string, init?: RequestInit & { admin?: boolean }): Promise<T> {
  const r = await fetch(`/api/gyt${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (r.status === 204) return {} as T;
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const d = body.detail;
    const msg = typeof d === "string" ? d : Array.isArray(d) ? d.map((x: { msg: string; loc: string[] }) => `${x.loc.at(-1)}: ${x.msg}`).join("; ") : `Request failed (${r.status})`;
    throw new Error(msg);
  }
  return body as T;
}

export const usd = (v: number | string | null | undefined, compact = false) => {
  const n = Number(v ?? 0);
  if (compact && n >= 1e6) return `$${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M`;
  if (compact && n >= 1e3) return `$${Math.round(n / 1e3).toLocaleString()}k`;
  return `$${Math.round(n).toLocaleString()}`;
};

export type Yacht = {
  id: string;
  name: string;
  mmsi: string | null;
  flag: string;
  loa_m: string;
  beam_m: string;
  year_built: number | null;
  builder: string | null;
  home_marina_id: string;
  marina_name: string;
  berth_code: string | null;
  valuation_usd: string | null;
  charter_week_usd: string | null;
  units_total: number;
  tokenized: boolean;
  insurance_verified: boolean;
  inspection_status: string;
  docs_root: string | null;
  last_position: { lat: number; lon: number; source: string; observed_at: string } | null;
};

export type Passport = Yacht & {
  condition: { score: number; factors: { label: string; points: number }[]; valuation_band_usd: [number, number] };
  documents: { kind: string; filename: string; sha256: string }[];
  latest_event: { id: number; event_type: string; leaf: string; anchor_id: number | null; pending: number } | null;
};
