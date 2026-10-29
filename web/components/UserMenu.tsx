"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function UserMenu({ name, email, role, status }: { name: string; email: string; role: string; status: string }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const initials = name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.assign("/");
  }

  async function refresh() {
    await fetch("/api/auth/refresh", { method: "POST" });
    router.refresh();
    setOpen(false);
  }

  return (
    <div className="usermenu">
      <button className="avatar" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} title={email}>
        {initials}
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-head">
            <b>{name}</b>
            <span className="small muted">{email}</span>
            <span className="row" style={{ gap: 6 }}>
              <span className="pill">{role}</span>
              <span className={`pill ${status === "active" ? "ok" : status === "pending" ? "warn" : "crit"}`}>{status}</span>
            </span>
          </div>
          {status === "pending" && (
            <p className="small muted" style={{ margin: 0 }}>
              An admin reviews new accounts. You can browse and track now; bookings open after approval.
            </p>
          )}
          <button role="menuitem" onClick={refresh}>Check approval status</button>
          <button role="menuitem" onClick={signOut}>Sign out</button>
        </div>
      )}
    </div>
  );
}
