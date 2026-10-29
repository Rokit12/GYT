"use client";

import { useState } from "react";

// Same rules the API enforces (auth.password_problems), plus a strength hint.
export function passwordChecks(pw: string) {
  return [
    { ok: pw.length >= 8, label: "8+ characters" },
    { ok: /[a-z]/i.test(pw), label: "A letter" },
    { ok: /\d/.test(pw), label: "A number" },
  ];
}
export function passwordScore(pw: string) {
  if (!pw) return 0;
  let s = passwordChecks(pw).filter((c) => c.ok).length;
  if (pw.length >= 12) s++;
  if (/[^a-z0-9]/i.test(pw) && /[A-Z]/.test(pw)) s++;
  return Math.min(4, Math.max(1, s - 1));
}
const WORDS = ["", "Weak", "Fair", "Good", "Strong"];

export default function PasswordField({ id, label, value, onChange, autoComplete = "new-password", meter = true }: {
  id: string; label: string; value: string; onChange: (v: string) => void; autoComplete?: string; meter?: boolean;
}) {
  const [show, setShow] = useState(false);
  const score = passwordScore(value);
  return (
    <div className="pwfield">
      <label className="f" htmlFor={id}>{label}
        <span className="pw-wrap">
          <input id={id} type={show ? "text" : "password"} value={value} autoComplete={autoComplete} required
            onChange={(e) => onChange(e.target.value)} aria-describedby={meter ? `${id}-hint` : undefined} />
          <button type="button" className="pw-eye" onClick={() => setShow(!show)} aria-label={show ? "Hide password" : "Show password"} aria-pressed={show}>
            {show ? "Hide" : "Show"}
          </button>
        </span>
      </label>
      {meter && (
        <div id={`${id}-hint`} className="pw-meter" aria-live="polite">
          <span className={`pw-bars s${score}`} aria-hidden="true"><i /><i /><i /><i /></span>
          <span className="small">{value ? WORDS[score] : "Choose a password"}</span>
          <span className="pw-checks">
            {passwordChecks(value).map((c) => <span key={c.label} className={c.ok ? "ok" : ""}>{c.ok ? "✓" : "○"} {c.label}</span>)}
          </span>
        </div>
      )}
    </div>
  );
}
