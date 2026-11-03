"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { allowed, rightFor, useAdminMe } from "@/components/admin/useAdminMe";

/** Shows a page only to admins with its right; others get a plain explanation instead. */
export default function AdminGate({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const me = useAdminMe();
  const need = rightFor(path);
  if (need === null || allowed(me, need)) return <>{children}</>;
  if (!me) return <p className="small muted">Checking your admin rights…</p>;
  const label = need === "primary" ? "primary admin" : me.rights.find((r) => r.key === need)?.label ?? need;
  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>You don&apos;t have access to this page</h2>
      <p>{need === "primary" ? "Only the primary admin can manage admins and their rights." : <>This page needs the <b>{label}</b> right. Ask the primary admin to add it to your account.</>}</p>
      <Link className="btn" href="/admin">Back to the dashboard</Link>
    </div>
  );
}
