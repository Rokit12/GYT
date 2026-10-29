import { Head } from "@/components/admin/kit";

export const metadata = { title: "GYT · Documentation" };

const STREAMS: [string, string, string, string][] = [
  ["Onboarding & digital twin", "Owner / SPV", "$5k–25k per yacht", "No"],
  ["Tokenization (issuance)", "Issuer SPV", "1–3% of units sold", "Yes, via licensed partner"],
  ["Secondary transfers", "Buyer + seller", "0.5–1% per trade", "Yes"],
  ["Charter take-rate", "Charterer / owner", "8–12% of booking", "Varies"],
  ["Berth commission", "Marina", "8–15% of stay", "No"],
  ["Marina SaaS", "Marina", "$5–12 per berth / month", "No"],
  ["Tracking & proof subscription", "Owner / manager", "$150–400 per yacht / month", "No"],
  ["Data & verification API", "Insurers, lenders, brokers", "Per call or annual licence", "No"],
  ["Escrow & payments float", "Embedded", "0.3–1% processing margin", "Partner"],
];

export default function Docs() {
  return (
    <>
      <Head eyebrow="Records · internal" title="Documentation" />
      <p className="banner small">Internal material for the GYT team. None of this page is shown to clients.</p>
      <div className="panel prose">
        <h3>Revenue model</h3>
        <p>Four layers: putting a yacht on-chain, moving economic units, using the yacht and its berth, and selling verified data. Start with the streams that need no securities licence; add issuance and trading through a licensed partner.</p>
        <div className="tbl"><table>
          <thead><tr><th>Stream</th><th>Who pays</th><th>Pricing to test</th><th>Licence needed</th></tr></thead>
          <tbody>{STREAMS.map((r) => <tr key={r[0]}>{r.map((c, i) => <td key={i}>{c}</td>)}</tr>)}</tbody>
        </table></div>
      </div>
      <div className="grid g2">
        <div className="panel prose">
          <h3>Tracking stack</h3>
          <p>Arrival needs a signed onboard GPS fix plus AIS or satellite SAR agreeing within 1.5 km. If AIS disagrees, spoofing is flagged and SAR becomes mandatory. SAR hull length must be within 20% of the registered length.</p>
          <p>OSIRIS (ESA GSTP, CNR-ISTI) is a research platform without a public API; the codebase has an adapter for a partner deployment. Live AIS uses AISHub; SAR detections use the Global Fishing Watch API.</p>
        </div>
        <div className="panel prose">
          <h3>Operating rules</h3>
          <ul>
            <li>New client accounts start as pending. Approve them in Users &amp; approvals before they can book or submit yachts.</li>
            <li>Yachts move Submitted → Verified → Minted. Units can only be issued after the twin is minted and the yacht&apos;s compliance rules are set.</li>
            <li>Retiring a yacht or deleting an investor is a soft delete; proofs stay verifiable.</li>
            <li>Bank account numbers are encrypted at rest and shown only as the last four digits.</li>
          </ul>
        </div>
      </div>
    </>
  );
}
