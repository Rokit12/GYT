import { NextRequest, NextResponse } from "next/server";
import { COOKIE, readSession } from "@/lib/session";

// Page access. The API enforces the same rules on every call; this only routes people.
// Signed-out visitors to a client feature see what it is first (a preview page at the same URL),
// with sign-up and sign-in buttons, instead of being bounced straight to the sign-in form.
const PREVIEW: Record<string, string> = { "/track/device": "device", "/track": "track", "/earn": "earn", "/onboard": "onboard", "/account": "account" };
const ADMIN = ["/admin"];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const user = await readSession(req.cookies.get(COOKIE)?.value);
  const needsAdmin = ADMIN.some((p) => pathname.startsWith(p));
  if (needsAdmin) {
    if (!user) {
      const url = new URL("/signin", req.url);
      url.searchParams.set("next", pathname);
      return NextResponse.redirect(url);
    }
    if (user.role !== "admin" || user.status !== "active") return NextResponse.redirect(new URL("/?denied=admin", req.url));
    return NextResponse.next();
  }
  const base = Object.keys(PREVIEW).find((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (base && !user) {
    const url = req.nextUrl.clone();
    url.pathname = `/preview/${PREVIEW[base]}`;
    url.searchParams.set("next", pathname + req.nextUrl.search);
    return NextResponse.rewrite(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ["/earn/:path*", "/track/:path*", "/onboard/:path*", "/account/:path*", "/admin/:path*"] };
