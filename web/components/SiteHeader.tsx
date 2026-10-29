import Link from "next/link";
import { getSession } from "@/lib/server-session";
import NavLinks from "./NavLinks";
import UserMenu from "./UserMenu";

export default async function SiteHeader() {
  const user = await getSession();
  const links: { href: string; label: string }[] = [
    { href: "/yachts", label: "Explore yachts" },
    { href: "/track", label: "Track & verify" },
    { href: "/earn", label: "Use or Earn" },
    { href: "/onboard", label: "List your yacht" },
  ];
  if (user?.role === "admin") links.push({ href: "/admin", label: "Admin console" });
  return (
    <header className="bar">
      <div className="wrap">
        <Link href="/" className="brand" aria-label="GYT home">
          <b>GYT</b>
          <span>Global Yacht Tokenization</span>
        </Link>
        <NavLinks links={links} />
        <div className="bar-right">
          {user ? (
            <UserMenu name={user.name} email={user.email} role={user.role} status={user.status} />
          ) : (
            <>
              <Link href="/signin" className="btn ghost">Sign in</Link>
              <Link href="/signup" className="btn primary">Get started</Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
