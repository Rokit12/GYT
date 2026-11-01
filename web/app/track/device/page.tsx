import DeviceTracker from "@/components/DeviceTracker";

export const metadata = { title: "Track from this device · GYT" };

export default function TrackFromDevice() {
  return (
    <main className="wrap page">
      <div>
        <div className="eyebrow">Track &amp; verify</div>
        <h1>Track from this device</h1>
        <p className="lede">
          No tracker on board? Open this page on your phone or laptop while you&apos;re aboard and press Start. Your device&apos;s
          location becomes the yacht&apos;s position on the GYT map for as long as you share.
        </p>
      </div>
      <DeviceTracker />
    </main>
  );
}
