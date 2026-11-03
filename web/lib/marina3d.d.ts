export type Berth3D = {
  code: string; loa: number; beam: number; depth?: number | null; state: string; best?: boolean;
  moored?: { loa: number; beam: number; name?: string; misfit?: boolean } | null;
  held?: { loa: number } | null;
};
export type Marina3DState = { berths?: Berth3D[]; yacht?: { name: string; loa: number; beam: number } | null; selected?: string | null };
export type Marina3D = { set(s: Marina3DState): void; select(code: string | null): void; dock(code: string): void; screenOf(code: string): { x: number; y: number } | null; resetView(): void; dispose(): void };
export function createMarina3D(THREE: unknown, el: HTMLElement, opts?: { onPick?: (code: string) => void; onDocked?: (code: string) => void }): Marina3D;
