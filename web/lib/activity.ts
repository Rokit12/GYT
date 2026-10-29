// Groups raw event types into the categories clients filter by.
export type Cat = "movement" | "arrival" | "care" | "money" | "ownership";
export const CATS: [Cat | "all", string][] = [
  ["all", "All"], ["movement", "Movement"], ["arrival", "Arrivals"], ["care", "Maintenance & documents"],
  ["money", "Bookings & payments"], ["ownership", "Ownership"],
];
export function category(t: string): Cat {
  if (/ARRIVAL/.test(t)) return "arrival";
  if (/UNITS|TRANSFER|TWIN|MINT/.test(t)) return "ownership";
  if (/BOOK|RESERVE|ESCROW|STAY|PAYOUT|PAYMENT|REFUND/.test(t)) return "money";
  if (/MAINT|DOC|INSPECT|SURVEY|VERIF|RECORD|ONBOARD|INSUR/.test(t)) return "care";
  return "movement";
}
export const ICON: Record<Cat, string> = { movement: "⌖", arrival: "⚓", care: "✎", money: "$", ownership: "◈" };
export const label = (t: string) => t.replaceAll("_", " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
export function ago(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
