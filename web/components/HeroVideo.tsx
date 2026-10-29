"use client";

import { useEffect, useRef, useState } from "react";

// Background video for the home hero. Swap the file with NEXT_PUBLIC_HERO_VIDEO_URL (for example a
// licensed stock clip) without changing code. The poster shows first and stays for reduced motion.
const SRC = process.env.NEXT_PUBLIC_HERO_VIDEO_URL ?? "/media/hero-yacht.mp4";
const POSTER = process.env.NEXT_PUBLIC_HERO_POSTER_URL ?? "/media/hero-yacht.jpg";

export default function HeroVideo() {
  const v = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(true);

  useEffect(() => {
    const el = v.current;
    if (!el) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const apply = () => {
      if (reduce?.matches) { el.pause(); setPlaying(false); }
      else el.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    };
    apply();
    reduce?.addEventListener?.("change", apply);
    // Pause while the hero is off screen to save battery.
    const io = new IntersectionObserver(([e]) => { if (!e.isIntersecting) el.pause(); else if (!reduce?.matches && playing) el.play().catch(() => {}); });
    io.observe(el);
    return () => { reduce?.removeEventListener?.("change", apply); io.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggle() {
    const el = v.current;
    if (!el) return;
    if (el.paused) el.play().then(() => setPlaying(true)).catch(() => {}); else { el.pause(); setPlaying(false); }
  }

  return (
    <>
      <video ref={v} className="hero-video" src={SRC} poster={POSTER} muted loop playsInline autoPlay preload="auto" aria-hidden="true" />
      <div className="hero-shade" aria-hidden="true" />
      <button type="button" className="hero-pause" onClick={toggle} aria-label={playing ? "Pause background video" : "Play background video"}>
        {playing ? "❚❚" : "▶"}
      </button>
    </>
  );
}
