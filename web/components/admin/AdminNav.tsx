"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const GROUPS: [string, [string, string][]][] = [
  ["Overview", [["/admin", "Dashboard"], ["/admin/monitoring", "Yacht monitoring"]]],
  ["Registry", [["/admin/yachts", "Yachts & minting"], ["/admin/hashes", "Hashes & addresses"]]],
  ["People & money", [["/admin/users", "Users & approvals"], ["/admin/investors", "Investors & KYC"], ["/admin/banking", "Banking details"]]],
  ["Operations", [["/admin/operations", "Bookings & escrow"], ["/admin/marinas", "Marinas & berths"]]],
  ["Records", [["/admin/audit", "Audit log"], ["/admin/docs", "Documentation"]]],
];

export default function AdminNav() {
  const path = usePathname();
  return (
    <nav className="admin-nav" aria-label="Admin">
      {GROUPS.map(([g, items]) => (
        <div key={g}>
          <div className="eyebrow">{g}</div>
          {items.map(([href, label]) => (
            <Link key={href} href={href} aria-current={(href === "/admin" ? path === href : path.startsWith(href)) ? "page" : undefined}>
              {label}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );
}
