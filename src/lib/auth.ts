import crypto from "node:crypto";
import { cookies } from "next/headers";

export const ADMIN_COOKIE = "atlas_admin";

function sessionToken() {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return null;

  const secret = process.env.SESSION_SECRET || "local-development-secret";
  return crypto
    .createHash("sha256")
    .update(`${password}:${secret}`)
    .digest("hex");
}

export function isValidAdminPassword(password: string) {
  const configured = process.env.ADMIN_PASSWORD;
  if (!configured) return false;

  const candidate = Buffer.from(password);
  const expected = Buffer.from(configured);
  return (
    candidate.length === expected.length &&
    crypto.timingSafeEqual(candidate, expected)
  );
}

export async function isAdminAuthenticated() {
  const token = sessionToken();
  if (!token) return false;

  const cookieStore = await cookies();
  const candidate = cookieStore.get(ADMIN_COOKIE)?.value;
  if (!candidate) return false;

  const candidateBuffer = Buffer.from(candidate);
  const tokenBuffer = Buffer.from(token);
  return (
    candidateBuffer.length === tokenBuffer.length &&
    crypto.timingSafeEqual(candidateBuffer, tokenBuffer)
  );
}

export function getAdminSessionToken() {
  return sessionToken();
}
