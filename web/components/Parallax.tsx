"use client";

import { useEffect, useRef } from "react";

/** Background image that drifts slower than the page as you scroll. Still for reduced motion. */
export default function Parallax({ src, className = "" }: { src: string; className?: string }) {
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const f = () => { if (ref.current) ref.current.style.transform = `translateY(${Math.min(80, window.scrollY * 0.18).toFixed(1)}px) scale(1.04)`; };
    window.addEventListener("scroll", f, { passive: true });
    return () => window.removeEventListener("scroll", f);
  }, []);
  // eslint-disable-next-line @next/next/no-img-element
  return <img ref={ref} src={src} alt="" aria-hidden="true" className={className} />;
}
