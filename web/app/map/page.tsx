import YachtMapExplorer from "@/components/YachtMapExplorer";

export const metadata = { title: "Yacht map · GYT" };

export default function MapPage({ searchParams }: { searchParams: { yacht?: string } }) {
  return (
    <main className="wrap page">
      <div>
        <div className="eyebrow">Yacht map</div>
        <h1>Where every yacht is</h1>
        <p className="lede">
          The latest position of every verified yacht on OpenStreetMap, from hardware GPS, an owner&apos;s or captain&apos;s
          phone, or public AIS. Positions refresh every 15 seconds.
        </p>
      </div>
      <YachtMapExplorer initialFocus={searchParams.yacht ?? null} />
    </main>
  );
}
