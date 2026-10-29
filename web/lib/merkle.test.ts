import { describe, expect, it } from "vitest";
import { bytesToHex, computeRoot, merkleRoot, sha256 } from "./merkle";

// Same vector as api/tests/test_units.py and contracts/test/ProofAndEscrow.t.sol
describe("merkle", () => {
  it("matches the shared vector", async () => {
    const leaves = await Promise.all([0, 1, 2, 3, 4].map((i) => sha256(new Uint8Array([i]))));
    const root = await merkleRoot(leaves);
    expect(root).toBe("9674600fd139741c0f7dd7a32d984a0e74401cc90e6e8e5d203ed973d27324fe");
    const r = await computeRoot(
      bytesToHex(leaves[4]),
      [
        "e52d9c508c502347344d8c07ad91cbd6068afc75ff6292f062a09ca381c89e71",
        "0e68f91a160a8a636202faf51d6b64cdc99ab3a1261f61f4556dc481997c66cb",
        "9675e04b4ba9dc81b06e81731e2d21caa2c95557a85dcfa3fff70c9ff0f30b2e",
      ],
      4,
    );
    expect(r.root).toBe(root);
  });
});
