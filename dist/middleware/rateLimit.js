import rateLimit from "express-rate-limit";
import { env } from "../config/env.js";
function bypassInDevelopment(_req, _res, next) {
    next();
}
function createAuthRateLimiter(max) {
    return rateLimit({
        windowMs: 15 * 60 * 1000,
        max,
        standardHeaders: true,
        legacyHeaders: false,
        skipSuccessfulRequests: true,
        message: {
            message: "Too many authentication attempts. Please try again later."
        }
    });
}
export const loginRateLimiter = env.NODE_ENV === "development" ? bypassInDevelopment : createAuthRateLimiter(20);
export const registerRateLimiter = env.NODE_ENV === "development" ? bypassInDevelopment : createAuthRateLimiter(10);
function createGlobalRateLimiter() {
    return rateLimit({
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 1000, // Limit each IP to 1000 requests per window
        standardHeaders: true,
        legacyHeaders: false,
        message: {
            message: "Too many requests. Please try again later."
        }
    });
}
export const globalRateLimiter = env.NODE_ENV === "development" ? bypassInDevelopment : createGlobalRateLimiter();
