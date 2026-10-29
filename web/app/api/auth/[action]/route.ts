import { NextRequest, NextResponse } from "next/server";
import { COOKIE } from "@/lib/session";

const API_URL = process.env.API_URL ?? "http://localhost:8000";

function withSession(body: unknown, token: string | null, status = 200) {
  const res = NextResponse.json(body, { status });
  if (token) {
    res.cookies.set(COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production" && process.env.INSECURE_COOKIES !== "1",
      path: "/",
      maxAge: 60 * 60 * 12,
    });
  }
  return res;
}

// POST /api/auth/login | signup | logout | refresh
export async function POST(req: NextRequest, { params }: { params: { action: string } }) {
  const { action } = params;
  if (action === "logout") {
    const res = NextResponse.json({ ok: true });
    res.cookies.delete(COOKIE);
    return res;
  }
  if (action === "refresh") {
    const token = req.cookies.get(COOKIE)?.value;
    if (!token) return NextResponse.json({ detail: "Not signed in" }, { status: 401 });
    const r = await fetch(`${API_URL}/auth/me`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    const body = await r.json();
    return r.ok ? withSession({ user: body }, body.token) : NextResponse.json(body, { status: r.status });
  }
  if (action !== "login" && action !== "signup") return NextResponse.json({ detail: "Not found" }, { status: 404 });
  const r = await fetch(`${API_URL}/auth/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: await req.text(),
    cache: "no-store",
  });
  const body = await r.json();
  if (!r.ok) return NextResponse.json(body, { status: r.status });
  return withSession({ user: body.user }, body.token, r.status);
}
