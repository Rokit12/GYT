"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";

export default function AuthForm({ mode }: { mode: "signin" | "signup" }) {
  const next = useSearchParams().get("next") ?? "/";
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    const r = await fetch(`/api/auth/${mode === "signin" ? "login" : "signup"}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mode === "signin" ? { email: form.email, password: form.password } : form),
    });
    const body = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) {
      const d = body.detail;
      setErr(typeof d === "string" ? d : Array.isArray(d) ? d.map((x: { msg: string }) => x.msg).join("; ") : "Something went wrong");
      return;
    }
    // Full navigation so the middleware and server components see the new session cookie.
    window.location.assign(body.user?.role === "admin" && next === "/" ? "/admin" : next);
  }

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="auth">
      <div className="auth-card panel">
        <div className="eyebrow">{mode === "signin" ? "Welcome back" : "Create your account"}</div>
        <h1>{mode === "signin" ? "Sign in" : "Get started"}</h1>
        <p className="muted small">
          {mode === "signin"
            ? "Track yachts, verify records and manage your bookings."
            : "Browse and track right away. An admin approves new accounts before bookings and investments open."}
        </p>
        <form onSubmit={submit} className="stack">
          {mode === "signup" && (
            <label className="f" htmlFor="name">Full name<input id="name" autoComplete="name" required value={form.name} onChange={set("name")} /></label>
          )}
          <label className="f" htmlFor="email">Email<input id="email" type="email" autoComplete="email" required value={form.email} onChange={set("email")} /></label>
          <label className="f" htmlFor="password">Password
            <input id="password" type="password" required minLength={mode === "signup" ? 8 : 1}
              autoComplete={mode === "signin" ? "current-password" : "new-password"} value={form.password} onChange={set("password")} />
          </label>
          {mode === "signup" && <span className="small muted">At least 8 characters, with a letter and a number.</span>}
          {err && <p className="err" role="alert">{err}</p>}
          <button className="primary" disabled={busy} type="submit">{busy ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}</button>
        </form>
        <p className="small muted">
          {mode === "signin" ? <>New to GYT? <Link href="/signup">Create an account</Link></> : <>Already have an account? <Link href="/signin">Sign in</Link></>}
        </p>
      </div>
    </div>
  );
}
