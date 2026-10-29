"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/** Follow / Following toggle. Signed-out visitors get a nudge to create an account. */
export default function FollowButton({ yachtId, name }: { yachtId: string; name: string }) {
  const [state, setState] = useState<"loading" | "out" | "on" | "off">("loading");
  const [pop, setPop] = useState(false);
  useEffect(() => {
    fetch("/api/gyt/me/follows", { cache: "no-store" })
      .then(async (r) => (r.status === 401 ? setState("out") : setState((await r.json()).includes(yachtId) ? "on" : "off")))
      .catch(() => setState("out"));
  }, [yachtId]);
  async function toggle() {
    const on = state === "on";
    setState(on ? "off" : "on");
    if (!on) { setPop(true); setTimeout(() => setPop(false), 600); }
    const r = await fetch(`/api/gyt/me/follows/${yachtId}`, { method: on ? "DELETE" : "PUT" });
    if (!r.ok) setState(on ? "on" : "off");
  }
  if (state === "out") return <Link className="btn followbtn" href={`/signup`}>☆ Follow</Link>;
  return (
    <button className={`followbtn ${state === "on" ? "on" : ""} ${pop ? "pop" : ""}`} onClick={toggle} disabled={state === "loading"}
      aria-pressed={state === "on"} aria-label={state === "on" ? `Unfollow ${name}` : `Follow ${name}`}>
      {state === "on" ? "★ Following" : "☆ Follow"}
    </button>
  );
}
