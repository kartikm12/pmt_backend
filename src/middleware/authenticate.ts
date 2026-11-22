import type { NextFunction, Request, Response } from "express";
import { ApiError } from "../utils/apiError.js";
import { verifyAccessToken } from "../utils/jwt.js";
import { prisma } from "../prisma/client.js";
import { SessionService } from "../services/session.service.js";

export const SUSPENDED_MESSAGE = "Your account is suspended. Contact your manager.";
export const PENDING_MESSAGE = "Your account is waiting for a manager's approval. You can sign in once it's approved.";

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

  // 2. Check it against the database. If the database itself fails (busy, connection refused), that is
  // NOT a bad sign-in: it used to be reported as 401, so the app signed people out during a busy moment.
  try {
    // Session check and fresh user data (so role changes apply at once) run side by side: this middleware
    // fronts every request, and each sequential database trip costs ~160 ms on the live hosting
    const [, user] = await Promise.all([
      SessionService.validateActiveSession(payload.sessionId, payload.userId),
      prisma.user.findFirst({
        where: { id: payload.userId, deletedAt: null },
        select: {
          id: true,
          fullName: true,
          email: true,
          role: true,
          status: true,
          pendingApproval: true
        }
      })
    ]);

    if (!user) {
      return next(new ApiError(401, "User no longer exists"));
    }
    if (user.status === "SUSPENDED") {
      return next(new ApiError(401, SUSPENDED_MESSAGE));
    }
    if (user.pendingApproval) {
      return next(new ApiError(401, PENDING_MESSAGE));
    }

    req.user = {
      userId: user.id,
      sessionId: payload.sessionId,
      email: user.email,
      role: user.role as any, // Cast to any to match expected type
      fullName: user.fullName
    };
    
    next();
  } catch (err) {
    if (err instanceof ApiError) return next(err); // ended session, removed person: these are real 401s
    console.error("Sign-in check couldn't reach the database:", err instanceof Error ? err.message : err);
    next(new ApiError(503, "The server is busy right now. Try again in a moment."));
  }
}
