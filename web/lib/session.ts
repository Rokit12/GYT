import { jwtVerify } from "jose";

export const COOKIE = "gyt_session";

export type SessionUser = {
  id: number;
  email: string;
  name: string;
  role: "client" | "admin";
  status: "pending" | "active" | "suspended";
  investorId: string | null;
  token: string;
};

const key = () => new TextEncoder().encode(process.env.JWT_SECRET ?? "");

// Verifies the session JWT (same secret as the API). Works in middleware (edge) and on the server.
export async function readSession(token: string | undefined): Promise<SessionUser | null> {
  if (!token || !process.env.JWT_SECRET) return null;
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ["HS256"] });
    return {
      id: Number(payload.sub),
      email: String(payload.email),
      name: String(payload.name),
      role: payload.role === "admin" ? "admin" : "client",
      status: (payload.st as SessionUser["status"]) ?? "active",
      investorId: (payload.inv as string | null) ?? null,
      token,
    };
  } catch {
    return null;
  }
}
