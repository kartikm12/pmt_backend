import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
export function signAccessToken(payload) {
    const options = {
        expiresIn: env.JWT_EXPIRES_IN
    };
    const token = jwt.sign(payload, env.JWT_SECRET, {
        ...options
    });
    const decoded = jwt.decode(token);
    if (!decoded || typeof decoded === "string" || !decoded.exp) {
        throw new Error("Failed to determine JWT expiration");
    }
    return {
        token,
        expiresAt: new Date(decoded.exp * 1000)
    };
}
export function verifyAccessToken(token) {
    return jwt.verify(token, env.JWT_SECRET);
}
