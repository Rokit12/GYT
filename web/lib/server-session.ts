import { cookies } from "next/headers";
import { COOKIE, readSession } from "./session";

export async function getSession() {
  return readSession(cookies().get(COOKIE)?.value);
}
