import BerthFinder from "@/components/BerthFinder";

export const metadata = { title: "Find a berth · GYT" };

export default function Berths() {
  return (
    <main className="wrap page">
      <div>
        <div className="eyebrow">Berths</div>
        <h1>Find a berth that fits</h1>
        <p className="lede">
          Every berth at the marina, drawn to scale against your yacht. Hold one while you confirm: other yachts see it
          as taken straight away, and no one can book a berth their yacht doesn&apos;t fit.
        </p>
      </div>
      <BerthFinder />
    </main>
  );
}
