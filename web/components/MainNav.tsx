"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

const ICON: Record<string, React.ReactNode> = {
  track: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2.2" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></svg>,
  verify: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l7 3v5c0 4.6-3 8.2-7 10-4-1.8-7-5.4-7-10V6z" /><path d="M8.6 12.2l2.4 2.4 4.6-4.8" /></svg>,
  earn: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 8h13l-3-3M20 16H7l3 3" /></svg>,
  phone: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="7" y="2.5" width="10" height="19" rx="2.2" /><path d="M11 18.5h2" /><path d="M12 7.2a2.4 2.4 0 0 1 2.4 2.4c0 1.8-2.4 4-2.4 4s-2.4-2.2-2.4-4A2.4 2.4 0 0 1 12 7.2z" /></svg>,
  list: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="5" r="2" /><path d="M12 7v13M5 13a7 7 0 0 0 14 0M8 11h8" /></svg>,
};
const PLATFORM = [
  { href: "/track", icon: "track", t: "Track & verify", d: "Follow a yacht live and check every record it leaves." },
  { href: "/track/device", icon: "phone", t: "Track from your phone", d: "No tracker on board? Share your phone's location as the yacht's." },
  { href: "/verify", icon: "verify", t: "Verify a record", d: "Paste any hash. Your browser checks it against the chain." },
  { href: "/earn", icon: "earn", t: "Use or Earn", d: "Turn ownership units into nights aboard, or into income." },
  { href: "/onboard", icon: "list", t: "List your yacht", d: "Get a verified passport and three-signal tracking." },
];

/** Main navigation: hover pill, ink under the current page, Platform mega menu, mobile drawer. */
export default function MainNav({ isAdmin, signedIn = false }: { isAdmin: boolean; signedIn?: boolean }) {
  const path = usePathname();
  const nav = useRef<HTMLElement>(null);
  const [drawer, setDrawer] = useState(false);
  const [mega, setMega] = useState(false);
  const hoverT = useRef<ReturnType<typeof setTimeout>>();
  const on = (h: string) => (h === "/" ? path === "/" : h === "/track" ? path === "/track" : path.startsWith(h));
  const platOn = PLATFORM.some((p) => on(p.href));
  const desk = () => window.matchMedia("(min-width: 921px)").matches;

  const placeInk = useCallback(() => {
    const n = nav.current;
    const ink = n?.querySelector<HTMLElement>(".nav-ink");
    if (!n || !ink) return;
    const cur = n.querySelector<HTMLElement>('.nl[aria-current="page"]');
    if (!cur || !desk()) { ink.style.opacity = "0"; return; }
    const a = n.getBoundingClientRect(), r = cur.getBoundingClientRect();
    ink.style.width = `${r.width - 28}px`;
    ink.style.transform = `translateX(${r.left - a.left + 14}px)`;
    ink.style.opacity = "1";
  }, []);

  useEffect(() => { setDrawer(false); setMega(false); requestAnimationFrame(placeInk); }, [path, placeInk]);
  useEffect(() => {
    const hdr = nav.current?.closest("header");
    const onScroll = () => hdr?.classList.toggle("scrolled", window.scrollY > 8);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setMega(false); setDrawer(false); } };
    const onResize = () => { if (desk()) setDrawer(false); placeInk(); };
    const onDoc = (e: MouseEvent) => { if (!(e.target as Element).closest?.(".mainnav")) setMega(false); };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    document.addEventListener("click", onDoc);
    document.fonts?.ready.then(placeInk);
    return () => {
      window.removeEventListener("scroll", onScroll); window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize); document.removeEventListener("click", onDoc);
    };
  }, [placeInk]);
  useEffect(() => { document.body.style.overflow = drawer ? "hidden" : ""; }, [drawer]);

  function pill(e: React.PointerEvent) {
    const n = nav.current, p = n?.querySelector<HTMLElement>(".nav-pill");
    const t = (e.target as Element).closest<HTMLElement>(".nav-list > li > .nl");
    if (!n || !p || !t || !desk()) return;
    const a = n.getBoundingClientRect(), r = t.getBoundingClientRect();
    p.style.width = `${r.width}px`; p.style.transform = `translateX(${r.left - a.left}px)`; p.style.opacity = "1";
  }

  const link = (href: string, label: string) => (
    <li><Link className="nl" href={href} aria-current={on(href) ? "page" : undefined}>{label}</Link></li>
  );
  return (
    <>
      <nav
        ref={nav} id="mainnav" className={`mainnav ${drawer ? "open" : ""}`} aria-label="Main"
        onPointerMove={pill}
        onPointerLeave={() => {
          const p = nav.current?.querySelector<HTMLElement>(".nav-pill"); if (p) p.style.opacity = "0";
          if (desk()) hoverT.current = setTimeout(() => setMega(false), 180);
        }}
        onPointerOver={(e) => {
          if (!desk() || e.pointerType === "touch") return;
          clearTimeout(hoverT.current);
          const li = (e.target as Element).closest(".nav-list > li");
          if (li) setMega(li.classList.contains("has-mega"));
        }}
      >
        <ul className="nav-list">
          {link("/yachts", "Explore yachts")}
          {link("/map", "Map")}
          {link("/how-it-works", "How it works")}
          <li className={`has-mega ${mega ? "open" : ""}`}>
            <button className="nl" type="button" aria-expanded={mega} aria-controls="mega-platform" aria-current={platOn ? "page" : undefined} onClick={() => setMega(!mega)}>
              Platform
              <svg className="chev" viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 3.5 5 7l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
            </button>
            <div className="mega" id="mega-platform">
              <div className="mega-links">
                {PLATFORM.map((p) => (
                  <Link key={p.href} className="mi" href={p.href}>
                    <span className="ic">{ICON[p.icon]}</span>
                    <span><b>{p.t}</b><span>{p.d}</span></span>
                  </Link>
                ))}
              </div>
              <Link className="mega-feature" href="/map">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/media/yachts/YACHT-000002.jpg" alt="" loading="lazy" />
                <span className="eyebrow">Live now</span>
                <b>See every yacht on the map</b>
                <span className="small">OpenStreetMap, live positions and trails</span>
              </Link>
            </div>
          </li>
          {link("/about", "About")}
          {signedIn && link("/account", "My GYT")}
          {isAdmin && link("/admin", "Admin console")}
        </ul>
        <span className="nav-pill" aria-hidden="true" />
        <span className="nav-ink" aria-hidden="true" />
      </nav>
      <button className="burger" aria-expanded={drawer} aria-controls="mainnav" aria-label={drawer ? "Close menu" : "Open menu"} onClick={() => setDrawer(!drawer)}>
        <span /><span /><span />
      </button>
      {drawer && <div className="nav-backdrop show" onClick={() => setDrawer(false)} />}
    </>
  );
}
