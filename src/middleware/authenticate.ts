import type { NextFunction, Request, Response } from "express";
import { ApiError } from "../utils/apiError.js";
import { verifyAccessToken } from "../utils/jwt.js";
import { prisma } from "../prisma/client.js";
import { SessionService } from "../services/session.service.js";
import { getCachedSignIn, rememberSignIn, type CachedUser } from "./authCache.js";

export const SUSPENDED_MESSAGE = "Your account is suspended. Contact your manager.";
export const PENDING_MESSAGE = "Your account is waiting for a manager's approval. You can sign in once it's approved.";

const inFlight = new Map<string, Promise<CachedUser>>();

// Session still active + fresh user data (so role changes apply at once), side by side
async function checkSignIn(token: string, payload: ReturnType<typeof verifyAccessToken>): Promise<CachedUser> {
  const [, user] = await Promise.all([
    SessionService.validateActiveSession(payload.sessionId, payload.userId),
    prisma.user.findFirst({
      where: { id: payload.userId, deletedAt: null },
      select: { id: true, fullName: true, email: true, role: true, status: true, pendingApproval: true }
    })
  ]);
  if (!user) throw new ApiError(401, "User no longer exists");
  if (user.status === "SUSPENDED") throw new ApiError(401, SUSPENDED_MESSAGE);
  if (user.pendingApproval) throw new ApiError(401, PENDING_MESSAGE);
  const checked: CachedUser = { userId: user.id, sessionId: payload.sessionId, email: user.email, role: user.role, fullName: user.fullName };
  rememberSignIn(token, checked);
  return checked;
}

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    return next(new ApiError(401, "Authentication required"));
  }

  const token = authHeader.replace("Bearer ", "");

  // 1. Is the sign-in itself good? Only a bad, expired or tampered token means "sign in again"
  let payload: ReturnType<typeof verifyAccessToken>;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return next(new ApiError(401, "Invalid or expired token"));
  }

  // Checked a moment ago (same sign-in, within 3 s, nothing changed since): no database trip
  const remembered = getCachedSignIn(token);
  if (remembered) {
    req.user = { ...remembered, role: remembered.role as any };
    return next();
  }

  // 2. Check it against the database. If the database itself fails (busy, connection refused), that is
  // NOT a bad sign-in: it used to be reported as 401, so the app signed people out during a busy moment.
  // Requests that arrive together with the same sign-in (a page opening 6 at once) share ONE check.
  try {
    let pending = inFlight.get(token);
    if (!pending) {
      pending = checkSignIn(token, payload);
      inFlight.set(token, pending);
      void pending.finally(() => inFlight.delete(token)).catch(() => undefined);
    }
    const user = await pending;
    req.user = { ...user, role: user.role as any };
    next();
  } catch (err) {
    if (err instanceof ApiError) return next(err); // ended session, removed person: these are real 401s
    console.error("Sign-in check couldn't reach the database:", err instanceof Error ? err.message : err);
    next(new ApiError(503, "The server is busy right now. Try again in a moment."));
  }
}
