import { NextRequest, NextResponse } from "next/server";
import { COOKIE, readSession } from "@/lib/session";

// Page access. The API enforces the same rules on every call; this only routes people to sign in.
const SIGNED_IN = ["/earn", "/track", "/onboard", "/account"];
const ADMIN = ["/admin"];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const user = await readSession(req.cookies.get(COOKIE)?.value);
  const needsAdmin = ADMIN.some((p) => pathname.startsWith(p));
  const needsUser = needsAdmin || SIGNED_IN.some((p) => pathname.startsWith(p));
  if (needsUser && !user) {
    const url = new URL("/signin", req.url);
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  if (needsAdmin && (user!.role !== "admin" || user!.status !== "active")) {
    return NextResponse.redirect(new URL("/?denied=admin", req.url));
  }
  return NextResponse.next();
}

export const config = { matcher: ["/earn/:path*", "/track/:path*", "/onboard/:path*", "/account/:path*", "/admin/:path*"] };
