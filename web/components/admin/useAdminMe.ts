"use client";

import { useEffect, useState } from "react";
import { call } from "@/lib/api";

export type AdminMe = { rights: { key: string; label: string }[]; me: { is_primary: boolean; rights: string[] } };

let cache: Promise<AdminMe> | null = null;

/** The signed-in admin's rights (the primary admin has them all). Fetched once per page load. */
export function useAdminMe() {
  const [me, setMe] = useState<AdminMe | null>(null);
  useEffect(() => {
    cache ??= call<AdminMe>("/admin/rights");
    cache.then(setMe).catch(() => { cache = null; });
  }, []);
  return me;
}

/** Which right each admin page needs. null = every admin; "primary" = the primary admin only. */
export const PAGE_RIGHT: [string, string | null][] = [
  ["/admin/admins", "primary"],
  ["/admin/autopilot", "autopilot"], ["/admin/monitoring", "monitoring"],
  ["/admin/yachts", "registry"], ["/admin/hashes", "registry"],
  ["/admin/users", "users"], ["/admin/investors", "investors"], ["/admin/banking", "banking"],
  ["/admin/berths", "berths"], ["/admin/marinas", "berths"], ["/admin/operations", "bookings"],
  ["/admin/audit", "audit"], ["/admin/docs", "docs"],
];

export function rightFor(path: string): string | null {
  const hit = PAGE_RIGHT.find(([p]) => path === p || path.startsWith(p + "/"));
  return hit ? hit[1] : null;
}

export function allowed(me: AdminMe | null, right: string | null): boolean {
  if (!me) return right === null;
  if (right === null) return true;
  if (right === "primary") return me.me.is_primary;
  return me.me.is_primary || me.me.rights.includes(right);
}
