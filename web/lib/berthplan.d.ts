export type PlanBerthOut = { code: string; max_loa_m: number; max_beam_m: number; max_draft_m: number; rate_usd_day: number; x: number; z: number; rot: number };
export type PlanSave = { marinaId: string; file: File | null; imageUrl: string | null; width_m: number; height_m: number; berths: PlanBerthOut[] };
export type PlanAIResult = {
  available: boolean; error?: string; note?: string; width_m?: number | null;
  berths?: { code?: string; end_x: number; end_y: number; tip_x: number; tip_y: number; width_frac: number; length_m?: number; beam_m?: number; depth_m?: number }[];
};
export type BerthPlanImporter = { state(): unknown; loadSample(): void; dispose(): void };
export function createBerthPlanImporter(
  THREE: unknown, createMarina3D: unknown, el: HTMLElement,
  opts: {
    marinas: { id: string; name: string }[]; marinaId?: string; sampleUrl?: string;
    detectAI?: (file: File) => Promise<PlanAIResult>;
    save: (p: PlanSave) => Promise<{ message?: string }>;
  },
): BerthPlanImporter;
export function detectBerths(img: { data: Uint8ClampedArray; width: number; height: number }): { ex: number; ey: number; dx: number; dy: number; len: number; wid: number }[];
export function codeBerths<T extends { ex: number; ey: number; dx: number; dy: number; wid: number; code?: string }>(bs: T[]): T[];
