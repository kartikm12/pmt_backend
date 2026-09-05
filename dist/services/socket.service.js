import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { verifyAccessToken } from "../utils/jwt.js";
import { redis } from "../utils/redis.js";
import { SessionService } from "./session.service.js";
export class SocketService {
    static _instance;
    io;
    userSockets = new Map(); // userId -> socketIds[]
    sessionSockets = new Map(); // sessionId -> socketIds[]
    constructor() { }
    static getInstance() {
        if (!SocketService._instance) {
            SocketService._instance = new SocketService();
        }
        return SocketService._instance;
    }
    async init(httpServer) {
        this.io = new Server(httpServer, {
            cors: {
                origin: env.CLIENT_URL,
                methods: ["GET", "POST"],
                credentials: true
            }
        });
        // Configure Redis Adapter for scalability
        if (env.REDIS_URL) {
            const pubClient = new Redis(env.REDIS_URL);
            const subClient = pubClient.duplicate();
            this.io.adapter(createAdapter(pubClient, subClient));
            console.log("Socket.io: Redis adapter initialized");
        }
        // Authentication Middleware
        this.io.use(async (socket, next) => {
            const token = socket.handshake.auth.token;
            if (!token) {
                return next(new Error("Authentication error: No token provided"));
            }
            try {
                const decoded = verifyAccessToken(token);
                await SessionService.validateActiveSession(decoded.sessionId, decoded.userId);
                socket.data.user = decoded;
                next();
            }
            catch (err) {
                next(new Error("Authentication error: Invalid token"));
            }
        });
        this.io.on("connection", (socket) => {
            const userId = socket.data.user.userId;
            const sessionId = socket.data.user.sessionId;
            // Layered Rate Limiting Middleware (Global + Per-Event)
            socket.use(async ([event, ..._args], next) => {
                if (!redis)
                    return next();
                try {
                    const now = Date.now();
                    const windowMs = 10000; // 10 second sliding window
                    const globalLimit = 30; // Max 30 messages per 10s across all events
                    const perEventLimit = 10; // Max 10 messages per 10s for any specific event
                    const globalKey = `ws_rl:global:${userId}`;
                    const eventKey = `ws_rl:event:${userId}:${event}`;
                    const penaltyKey = `ws_penalty:${userId}`;
                    // Check for active temporary ban/penalty
                    const hasPenalty = await redis.get(penaltyKey);
                    if (hasPenalty) {
                        socket.emit("error", { message: "Too many requests. Temporary suspension in effect." });
                        return; // Drop event
                    }
                    const multi = redis.multi();
                    // Global tracking
                    multi.zadd(globalKey, now, `${now}:${Math.random()}`);
                    multi.zremrangebyscore(globalKey, 0, now - windowMs);
                    multi.zcard(globalKey);
                    // Per-event tracking
                    multi.zadd(eventKey, now, `${now}:${Math.random()}`);
                    multi.zremrangebyscore(eventKey, 0, now - windowMs);
                    multi.zcard(eventKey);
                    // Set expiry to auto-clean
                    multi.expire(globalKey, 15);
                    multi.expire(eventKey, 15);
                    const results = await multi.exec();
                    if (!results)
                        return next();
                    // Get counts from ZCARD results
                    const globalCount = results[2][1];
                    const eventCount = results[5][1];
                    if (globalCount > globalLimit || eventCount > perEventLimit) {
                        console.warn(`[WS_RATE_LIMIT] User ${userId} exceeded limit (Global: ${globalCount}, Event: ${event}, EventCount: ${eventCount})`);
                        // Progressive Penalty: 1 minute ban if they keep spamming
                        await redis.set(penaltyKey, "1", "EX", 60);
                        socket.emit("error", { message: "Rate limit exceeded. Temporary suspension applied." });
                        return; // Drop event
                    }
                    next();
                }
                catch (err) {
                    console.error("WS Rate Limiter Error:", err);
                    next();
                }
            });
            console.log(`User connected: ${userId} (Socket: ${socket.id})`);
            // Add to userSockets map
            const sockets = this.userSockets.get(userId) || [];
            sockets.push(socket.id);
            this.userSockets.set(userId, sockets);
            const sessionSocketIds = this.sessionSockets.get(sessionId) || [];
            sessionSocketIds.push(socket.id);
            this.sessionSockets.set(sessionId, sessionSocketIds);
            // Join user-specific room
            socket.join(`user_${userId}`);
            socket.join(`session_${sessionId}`);
            // Handle custom events
            socket.on("join_project", (projectId) => {
                socket.join(`project_${projectId}`);
                console.log(`Socket ${socket.id} joined project room: project_${projectId}`);
            });
            socket.on("leave_project", (projectId) => {
                socket.leave(`project_${projectId}`);
                console.log(`Socket ${socket.id} left project room: project_${projectId}`);
            });
            socket.on("disconnect", () => {
                console.log(`User disconnected: ${userId} (Socket: ${socket.id})`);
                const sockets = this.userSockets.get(userId) || [];
                const index = sockets.indexOf(socket.id);
                if (index > -1) {
                    sockets.splice(index, 1);
                }
                if (sockets.length === 0) {
                    this.userSockets.delete(userId);
                }
                else {
                    this.userSockets.set(userId, sockets);
                }
                const sessionSockets = this.sessionSockets.get(sessionId) || [];
                const sessionIndex = sessionSockets.indexOf(socket.id);
                if (sessionIndex > -1) {
                    sessionSockets.splice(sessionIndex, 1);
                }
                if (sessionSockets.length === 0) {
                    this.sessionSockets.delete(sessionId);
                }
                else {
                    this.sessionSockets.set(sessionId, sessionSockets);
                }
            });
        });
        return this.io;
    }
    getIO() {
        if (!this.io) {
            throw new Error("Socket.io not initialized");
        }
        return this.io;
    }
    emitToUser(userId, event, data) {
        this.io?.to(`user_${userId}`).emit(event, data);
    }
    async forceLogoutSessions(sessionIds, message) {
        if (!this.io || sessionIds.length === 0) {
            return;
        }
        for (const sessionId of sessionIds) {
            this.io.to(`session_${sessionId}`).emit("force_logout", { message });
            const sockets = await this.io.in(`session_${sessionId}`).fetchSockets();
            sockets.forEach((socket) => socket.disconnect(true));
        }
    }
    emitToProject(projectId, event, data) {
        this.io?.to(`project_${projectId}`).emit(event, data);
    }
    emitToAll(event, data) {
        this.io?.emit(event, data);
    }
}
export const socketService = SocketService.getInstance();
