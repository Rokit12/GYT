// Browser-side proof verification. Tree rules match api/app/proof.py and ProofRegistry.sol:
// parent = sha256(left || right), ordered; leaf index bit i chooses left/right at level i.

export const hexToBytes = (hex: string): Uint8Array => {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
};

export const bytesToHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

const concat = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

export interface ProofStep {
  side: "left" | "right";
  sibling: string;
  result: string;
}

export async function computeRoot(leafHex: string, proofHex: string[], index: number) {
  let h = hexToBytes(leafHex);
  const steps: ProofStep[] = [];
  for (const sibHex of proofHex) {
    const sib = hexToBytes(sibHex);
    const left = (index & 1) === 1;
    h = left ? await sha256(concat(sib, h)) : await sha256(concat(h, sib));
    steps.push({ side: left ? "left" : "right", sibling: sibHex, result: bytesToHex(h) });
    index >>= 1;
  }
  return { root: bytesToHex(h), steps };
}

export async function merkleRoot(leaves: Uint8Array[]): Promise<string> {
  let lvl = leaves;
  while (lvl.length > 1) {
    const nxt: Uint8Array[] = [];
    for (let i = 0; i < lvl.length; i += 2) nxt.push(await sha256(concat(lvl[i], lvl[i + 1] ?? lvl[i])));
    lvl = nxt;
  }
  return bytesToHex(lvl[0]);
}

export async function hashFile(file: File): Promise<string> {
  return bytesToHex(await sha256(new Uint8Array(await file.arrayBuffer())));
}
