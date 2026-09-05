import { ApiError } from "../utils/apiError.js";
import { verifyAccessToken } from "../utils/jwt.js";
import { prisma } from "../prisma/client.js";
import { SessionService } from "../services/session.service.js";
export async function authenticate(req, _res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
        return next(new ApiError(401, "Authentication required"));
    }
    const token = authHeader.replace("Bearer ", "");
    try {
        const payload = verifyAccessToken(token);
        await SessionService.validateActiveSession(payload.sessionId, payload.userId);
        // Fetch latest user data from DB to ensure roles/permissions are instant
        const user = await prisma.user.findFirst({
            where: { id: payload.userId, deletedAt: null },
            select: {
                id: true,
                fullName: true,
                email: true,
                role: true
            }
        });
        if (!user) {
            return next(new ApiError(401, "User no longer exists"));
        }
        req.user = {
            userId: user.id,
            sessionId: payload.sessionId,
            email: user.email,
            role: user.role, // Cast to any to match expected type
            fullName: user.fullName
        };
        next();
    }
    catch (err) {
        next(err instanceof ApiError ? err : new ApiError(401, "Invalid or expired token"));
    }
}
