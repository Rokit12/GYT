"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { allowed, rightFor, useAdminMe } from "@/components/admin/useAdminMe";

const GROUPS: [string, [string, string][]][] = [
  ["Overview", [["/admin", "Dashboard"], ["/admin/autopilot", "Autopilot (AI)"], ["/admin/monitoring", "Yacht monitoring"]]],
  ["Registry", [["/admin/yachts", "Yachts & minting"], ["/admin/hashes", "Hashes & addresses"]]],
  ["People & money", [["/admin/users", "Users & approvals"], ["/admin/admins", "Admins & rights"], ["/admin/investors", "Investors & KYC"], ["/admin/banking", "Banking details"]]],
  ["Operations", [["/admin/berths", "Berth board"], ["/admin/berths/plan", "Berth plan to 3D"], ["/admin/operations", "Bookings & escrow"], ["/admin/marinas", "Marinas & berths"]]],
  ["Records", [["/admin/audit", "Audit log"], ["/admin/docs", "Documentation"]]],
];

/** The admin menu shows only the pages this admin has the right for. */
export default function AdminNav() {
  const path = usePathname();
  const me = useAdminMe();
  return (
    <nav className="admin-nav" aria-label="Admin">
      {GROUPS.map(([g, items]) => {
        const shown = items.filter(([href]) => allowed(me, rightFor(href)));
        if (!shown.length) return null;
        return (
          <div key={g}>
            <div className="eyebrow">{g}</div>
            {shown.map(([href, label]) => (
              <Link key={href} href={href} aria-current={(href === "/admin" || href === "/admin/berths" ? path === href : path.startsWith(href)) ? "page" : undefined}>
                {label}
              </Link>
            ))}
          </div>
        );
      })}
      {me && <p className="small muted admin-role">{me.me.is_primary ? "Primary admin · every right" : `Admin · ${me.me.rights.length} of ${me.rights.length} rights`}</p>}
    </nav>
  );
}
