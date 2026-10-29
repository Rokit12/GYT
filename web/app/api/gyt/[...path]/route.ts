import { NextRequest } from "next/server";
import { COOKIE } from "@/lib/session";

const API_URL = process.env.API_URL ?? "http://localhost:8000";

// Forwards to the API, attaching the signed-in user's session token from the httpOnly cookie.
// The API decides what each user may do; this proxy grants nothing by itself.
async function forward(req: NextRequest, { params }: { params: { path: string[] } }) {
  const token = req.cookies.get(COOKIE)?.value;
  const r = await fetch(`${API_URL}/${params.path.join("/")}${req.nextUrl.search}`, {
    method: req.method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: ["GET", "HEAD", "DELETE"].includes(req.method) ? undefined : await req.text(),
    cache: "no-store",
  });
  const text = r.status === 204 ? "" : await r.text();
  return new Response(text || null, { status: r.status, headers: { "Content-Type": "application/json" } });
}

export { forward as GET, forward as POST, forward as PUT, forward as PATCH, forward as DELETE };
