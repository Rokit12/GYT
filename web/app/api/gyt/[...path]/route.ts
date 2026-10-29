import { NextRequest } from "next/server";
import { COOKIE } from "@/lib/session";

const API_URL = process.env.API_URL ?? "http://localhost:8000";

// Forwards to the API, attaching the signed-in user's session token from the httpOnly cookie.
// The API decides what each user may do; this proxy grants nothing by itself.
// Bodies pass through as bytes, so image uploads (POST image/*) and photo downloads work too.
async function forward(req: NextRequest, { params }: { params: { path: string[] } }) {
  const token = req.cookies.get(COOKIE)?.value;
  const ctype = req.headers.get("content-type") ?? "application/json";
  const r = await fetch(`${API_URL}/${params.path.join("/")}${req.nextUrl.search}`, {
    method: req.method,
    headers: { "Content-Type": ctype, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: ["GET", "HEAD", "DELETE"].includes(req.method) ? undefined : await req.arrayBuffer(),
    cache: "no-store",
  });
  const headers = new Headers({ "Content-Type": r.headers.get("content-type") ?? "application/json" });
  const cc = r.headers.get("cache-control");
  if (cc) headers.set("Cache-Control", cc);
  return new Response(r.status === 204 ? null : await r.arrayBuffer(), { status: r.status, headers });
}

export { forward as GET, forward as POST, forward as PUT, forward as PATCH, forward as DELETE };
