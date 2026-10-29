"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

export default function NavLinks({ links }: { links: { href: string; label: string }[] }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="menu-toggle" aria-expanded={open} aria-controls="mainnav" onClick={() => setOpen(!open)}>
        Menu
      </button>
      <nav id="mainnav" className={`tabs ${open ? "open" : ""}`} aria-label="Main">
        {links.map((l) => (
          <Link key={l.href} href={l.href} aria-current={path.startsWith(l.href) ? "page" : undefined} onClick={() => setOpen(false)}>
            {l.label}
          </Link>
        ))}
      </nav>
    </>
  );
}
