import type { NextFunction, Request, Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { env } from "../config/env.js";
import { verifyAccessToken } from "../utils/jwt.js";

const WINDOW_MS = 15 * 60 * 1000;

function bypassInDevelopment(_req: Request, _res: Response, next: NextFunction) {
  next();
}

const addressKey = (req: Request) => ipKeyGenerator(req.ip ?? "");

// The signed-in person behind a request, or null. Only a token this server signed counts, so a made-up
// token can't buy a fresh allowance: it falls back to the internet address like any signed-out request.
const seen = new WeakMap<Request, string | null>(); // the limit and the key both ask: check the token once
function signedInUserId(req: Request): string | null {
  if (seen.has(req)) return seen.get(req)!;
  const header = req.headers.authorization;
  let userId: string | null = null;
  if (header?.startsWith("Bearer ")) {
    try {
      userId = verifyAccessToken(header.slice(7)).userId ?? null;
    } catch {
      userId = null;
    }
  }
  seen.set(req, userId);
  return userId;
}

// ---------------------------------------------------------------- sign-in, forgot / reset password
// Only FAILED attempts count. Two limits, both must allow:
//  - per account (address + email): 10 wrong passwords lock that one account on that address, not the office
//  - per address: 200 failures stops someone trying many accounts; a whole office never gets near it
function createAuthLimiters(perAccount: number, perAddress: number) {
  const message = { message: "Too many authentication attempts. Please try again later." };
  const common = { windowMs: WINDOW_MS, standardHeaders: true, legacyHeaders: false, skipSuccessfulRequests: true, message };
  const account = rateLimit({
    ...common,
    limit: perAccount,
    keyGenerator: (req) => `${addressKey(req)}|${String(req.body?.email ?? "").trim().toLowerCase()}`
  });
  const address = rateLimit({ ...common, limit: perAddress, keyGenerator: addressKey });
  return [account, address];
}

export const loginRateLimiter =
  env.NODE_ENV === "development" ? [bypassInDevelopment] : createAuthLimiters(10, 200);

export const registerRateLimiter =
  env.NODE_ENV === "development" ? [bypassInDevelopment] : createAuthLimiters(10, 50);

// ---------------------------------------------------------------- everything else
// Counted PER PERSON when signed in: an office of 150 behind one internet address used to share one
// allowance of 1000 and was locked out for 15 minutes within a minute of opening the app.
// Signed-out requests are still counted per internet address.
const PER_PERSON = 1000;
const PER_ADDRESS_SIGNED_OUT = 1000;

function createGlobalRateLimiter() {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit: (req) => (signedInUserId(req) ? PER_PERSON : PER_ADDRESS_SIGNED_OUT),
    keyGenerator: (req) => {
      const userId = signedInUserId(req);
      return userId ? `user:${userId}` : `ip:${addressKey(req)}`;
    },
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      message: "Too many requests. Please try again later."
    }
  });
}

export const globalRateLimiter =
  env.NODE_ENV === "development" ? bypassInDevelopment : createGlobalRateLimiter();
