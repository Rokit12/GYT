import HashCheck from "@/components/HashCheck";

export const metadata = { title: "GYT · Verify a record" };

export default function Verify({ searchParams }: { searchParams: { hash?: string } }) {
  return (
    <main className="wrap page">
      <div>
        <div className="eyebrow">Verify</div>
        <h1>Check any GYT record</h1>
        <p className="lede">Paste the hash of a yacht record. Your browser rebuilds its Merkle proof and compares it with the root anchored on-chain, so you do not have to trust GYT.</p>
      </div>
      <div className="panel"><HashCheck initial={searchParams.hash ?? ""} autoVerify={!!searchParams.hash} /></div>
    </main>
  );
}
