import type { NextFunction, Request, Response } from "express";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: number;
    }
  }
}

// Auth tokens are intentionally per-login (not a browser-wide cookie).
//
// Why: cookies are shared by every tab/window of the same browser against
// the same origin. In a collaborative app where testers routinely open
// multiple accounts side by side in separate tabs to simulate different
// project members, a cookie session means logging in as user B in tab 2
// silently swaps out user A's session in tab 1 too. Each login instead
// mints its own opaque bearer token; the client stores it in
// `sessionStorage` (tab-scoped, never shared across tabs) and sends it as
// `Authorization: Bearer <token>`, so concurrent logins never collide.
interface TokenEntry {
  userId: number;
  expiresAt: number;
}

const tokens = new Map<string, TokenEntry>();
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// An account may only be signed in in one place at a time. Tracking the
// single currently-valid token per user (separate from the token -> user
// map above, which still supports concurrent *different* accounts in
// different tabs) lets a fresh login immediately invalidate whatever
// session existed before it, anywhere.
const activeTokenByUser = new Map<number, string>();

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function createSessionToken(userId: number): string {
  // Kick out whatever session this account already had, wherever it was —
  // only the newest login should remain valid.
  const previousToken = activeTokenByUser.get(userId);
  if (previousToken) {
    tokens.delete(previousToken);
  }

  const token = crypto.randomBytes(32).toString("hex");
  tokens.set(token, { userId, expiresAt: Date.now() + TOKEN_TTL_MS });
  activeTokenByUser.set(userId, token);
  return token;
}

export function destroySessionToken(token: string): void {
  const entry = tokens.get(token);
  tokens.delete(token);
  if (entry && activeTokenByUser.get(entry.userId) === token) {
    activeTokenByUser.delete(entry.userId);
  }
}

function getBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

export function getUserIdFromRequest(req: Request): number | undefined {
  const token = getBearerToken(req);
  if (!token) return undefined;
  const entry = tokens.get(token);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    tokens.delete(token);
    return undefined;
  }
  return entry.userId;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const userId = getUserIdFromRequest(req);
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  req.userId = userId;
  next();
}
