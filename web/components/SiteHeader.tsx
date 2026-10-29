import Link from "next/link";
import { getSession } from "@/lib/server-session";
import { LogoLockup } from "./Logo";
import MainNav from "./MainNav";
import UserMenu from "./UserMenu";

export default async function SiteHeader() {
  const user = await getSession();
  return (
    <header className="bar nav2">
      <div className="wrap nav2-row">
        <Link href="/" className="brand2" aria-label="GYT, Global Yacht Tokenization, home"><LogoLockup /></Link>
        <MainNav isAdmin={user?.role === "admin"} signedIn={!!user} />
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
