"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { call } from "@/lib/api";

export function useData<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState("");
  const reload = useCallback(async () => {
    try {
      setData(await call<T>(path));
      setErr("");
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [path]);
  useEffect(() => { reload(); }, [reload]);
  return { data, err, reload };
}

export function useToast() {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const t = useRef<ReturnType<typeof setTimeout>>();
  const show = (ok: boolean, text: string) => {
    setMsg({ ok, text });
    clearTimeout(t.current);
    t.current = setTimeout(() => setMsg(null), 4000);
  };
  const node = msg ? <div className={`toast ${msg.ok ? "" : "bad"}`} role="status">{msg.text}</div> : null;
  return { show, node };
}

/** Runs an action, shows its result, reloads the data. */
export function useAct(reload: () => void, show: (ok: boolean, t: string) => void) {
  return async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      show(true, ok);
      reload();
      return true;
    } catch (e) {
      show(false, (e as Error).message);
      return false;
    }
  };
}

export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="dialog-back" onClick={onClose}>
      <div className="dialog panel" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header><h3>{title}</h3><button className="sm" onClick={onClose} aria-label="Close">Close</button></header>
        {children}
      </div>
    </div>
  );
}

/** Two-step delete so nothing is removed by a single stray click. */
export function ConfirmButton({ label, confirm, onConfirm }: { label: string; confirm: string; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  return armed ? (
    <span className="row" style={{ gap: 4 }}>
      <button className="sm danger" onClick={() => { setArmed(false); onConfirm(); }}>{confirm}</button>
      <button className="sm" onClick={() => setArmed(false)}>Cancel</button>
    </span>
  ) : (
    <button className="sm" onClick={() => setArmed(true)}>{label}</button>
  );
}

export const short = (h?: string | null, n = 10) => (h ? `${h.slice(0, n)}…${h.slice(-6)}` : "—");
export const when = (d?: string | null) => (d ? new Date(d).toLocaleString() : "—");

export function Head({ eyebrow, title, children }: { eyebrow: string; title: string; children?: React.ReactNode }) {
  return (
    <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-end" }}>
      <div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1></div>
      {children && <div className="row">{children}</div>}
    </div>
  );
}

export { call };
