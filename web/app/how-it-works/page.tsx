import Link from "next/link";
import { KineticHeadline } from "@/components/Kinetic";
import { Flow, Journey } from "@/components/HowJourney";
import { FAQ } from "@/lib/journeys";

export const metadata = { title: "GYT · How it works" };

export default function HowItWorks() {
  return (
    <main className="wrap page">
      <div className="pagehead">
        <div className="eyebrow">How it works</div>
        <KineticHeadline className="display" text="From first click to proven arrival." />
        <p className="lede">
          GYT works the same way for everyone: the yacht is verified once, followed by independent signals, and every step
          leaves a record you can check yourself. Pick who you are to see your path.
        </p>
      </div>
      <Journey />

      <div className="flowhead" id="flow">
        <div className="eyebrow">Behind every position</div>
        <h2>Three signals, one hash, anchored for good</h2>
        <p className="small muted">Hover a stage to see what it does. The dashes show records moving through the pipeline.</p>
      </div>
      <Flow />

      <div className="flowhead" id="faq"><div className="eyebrow">Questions</div><h2>What people ask first</h2></div>
      <div className="faq">
        {FAQ.map(([q, a], i) => (
          <details key={q} open={i === 0}><summary>{q}</summary><div className="ans">{a}</div></details>
        ))}
      </div>

      <div className="ctaband">
        <div><h2>Ready to look around?</h2><p className="muted">Browsing, tracking and verifying are free. Bookings open once an admin approves your account.</p></div>
        <div className="row"><Link className="btn primary lg" href="/yachts">Explore yachts</Link><Link className="btn lg" href="/signup">Create a free account</Link></div>
      </div>
    </main>
  );
}
