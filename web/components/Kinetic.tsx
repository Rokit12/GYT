"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Headline whose letters thicken as the pointer comes near (variable weight 300 to 900).
 * At rest it renders as normal text at full weight, so it reads the same without JavaScript.
 */
export function KineticHeadline({ text, className = "" }: { text: string; className?: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const h = ref.current;
    if (!h || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const letters = Array.from(h.querySelectorAll<HTMLSpanElement>(".kl"));
    let raf = 0, px = -1e4, py = -1e4;
    const paint = () => {
      raf = 0;
      for (const l of letters) {
        const r = l.getBoundingClientRect();
        const d = Math.hypot(r.left + r.width / 2 - px, r.top + r.height / 2 - py);
        const k = Math.max(0, 1 - d / 260);
        l.style.fontVariationSettings = `"wght" ${Math.round(420 + 480 * k)}`;
        l.style.transform = `translateY(${(-6 * k).toFixed(1)}px)`;
      }
    };
    const move = (e: PointerEvent) => { px = e.clientX; py = e.clientY; if (!raf) raf = requestAnimationFrame(paint); };
    const leave = () => { for (const l of letters) { l.style.fontVariationSettings = ""; l.style.transform = ""; } };
    h.parentElement?.addEventListener("pointermove", move);
    h.parentElement?.addEventListener("pointerleave", leave);
    return () => { h.parentElement?.removeEventListener("pointermove", move); h.parentElement?.removeEventListener("pointerleave", leave); cancelAnimationFrame(raf); };
  }, []);
  return (
    <h1 ref={ref} className={`kinetic ${className}`} aria-label={text}>
      {text.split(" ").map((w, i) => (
        <span key={i} className="kw" aria-hidden="true">
          {Array.from(w).map((c, j) => <span key={j} className="kl">{c}</span>)}
        </span>
      ))}
    </h1>
  );
}

/** Counts up to `value` once when it scrolls into view. Shows the final value without JavaScript. */
export function CountUp({ value, suffix = "" }: { value: number; suffix?: string }) {
  const [n, setN] = useState(value);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let started = false, raf = 0;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting || started) return;
      started = true;
      const t0 = performance.now();
      const step = (t: number) => {
        const u = Math.min(1, (t - t0) / 1200);
        setN(Math.round(value * (1 - (1 - u) ** 3)));
        if (u < 1) raf = requestAnimationFrame(step);
      };
      setN(0); raf = requestAnimationFrame(step);
    }, { threshold: 0.6 });
    io.observe(el);
    return () => { io.disconnect(); cancelAnimationFrame(raf); };
  }, [value]);
  return <span ref={ref} className="num">{n.toLocaleString()}{suffix}</span>;
}

/** 3D tilt and light sheen that follow the pointer. */
export function Tilt({ children, className = "", max = 7 }: { children: React.ReactNode; className?: string; max?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || !window.matchMedia?.("(hover: hover)").matches) return;
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      el.style.setProperty("--rx", `${((0.5 - y) * max).toFixed(2)}deg`);
      el.style.setProperty("--ry", `${((x - 0.5) * max).toFixed(2)}deg`);
      el.style.setProperty("--mx", `${(x * 100).toFixed(1)}%`);
      el.style.setProperty("--my", `${(y * 100).toFixed(1)}%`);
    };
    const leave = () => { el.style.setProperty("--rx", "0deg"); el.style.setProperty("--ry", "0deg"); };
    el.addEventListener("pointermove", move); el.addEventListener("pointerleave", leave);
    return () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerleave", leave); };
  }, [max]);
  return <div ref={ref} className={`tilt ${className}`}>{children}</div>;
}
