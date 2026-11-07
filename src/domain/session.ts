import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "cfv_session";
const SESSION_SECONDS = 60 * 60 * 12;

function b64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

export function signSession(secret: string, userId: string, nowMs: number): string {
  const body = b64url(JSON.stringify({ uid: userId, exp: nowMs + SESSION_SECONDS * 1000 }));
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function readSession(secret: string, token: string | undefined, nowMs: number): { uid: string } | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { uid?: string; exp?: number };
    if (!payload.uid || typeof payload.exp !== "number" || payload.exp < nowMs) return null;
    return { uid: payload.uid };
  } catch {
    return null;
  }
}

export function sessionCookieHeader(token: string, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${SESSION_SECONDS}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=`, "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [rawKey, ...rest] = part.trim().split("=");
    if (rawKey === name) return rest.join("=");
  }
  return undefined;
}
