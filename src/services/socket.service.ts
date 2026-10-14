import { Server, Socket } from "socket.io";
import { Server as HttpServer } from "http";
import { createAdapter } from "@socket.io/redis-adapter";
import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { verifyAccessToken } from "../utils/jwt.js";
import { redis } from "../utils/redis.js";
import { SessionService } from "./session.service.js";

export class SocketService {
  private static _instance: SocketService;
  private io?: Server;
  private userSockets: Map<string, string[]> = new Map(); // userId -> socketIds[]
  private sessionSockets: Map<string, string[]> = new Map(); // sessionId -> socketIds[]

  private memoryHits: Map<string, number[]> = new Map(); // `${userId}:${bucket}` -> recent event times
  private memoryPenalty: Map<string, number> = new Map(); // userId -> blocked until (ms)

  private constructor() {}

  // Same rule as the Redis limiter: 30 events / 10 s per user, 10 per event type, then a 60 s penalty
  private memoryRateLimit(userId: string, event: string): "ok" | "limited" | "penalty" {
    const now = Date.now();
    if ((this.memoryPenalty.get(userId) ?? 0) > now) return "penalty";
    const count = (key: string) => {
      const hits = (this.memoryHits.get(key) ?? []).filter((t) => t > now - 10000);
      hits.push(now);
      this.memoryHits.set(key, hits);
      return hits.length;
    };
    // Clients pick event names freely; only known ones get their own bucket so the map can't grow without bound
    const bucket = event === "join_project" || event === "leave_project" ? event : "other";
    if (count(`${userId}:all`) > 30 || count(`${userId}:${bucket}`) > 10) {
      this.memoryPenalty.set(userId, now + 60000);
      console.warn(`[WS_RATE_LIMIT] User ${userId} exceeded limit (event: ${event}) - memory limiter`);
      return "limited";
    }
    return "ok";
  }

  public static getInstance(): SocketService {
    if (!SocketService._instance) {
      SocketService._instance = new SocketService();
    }
    return SocketService._instance;
  }

  public async init(httpServer: HttpServer) {
    this.io = new Server(httpServer, {
      cors: {
        origin: (origin, callback) => {
          if (!origin) return callback(null, true); // Allow non-browser clients
          const allowed =
            !origin ||
            origin === env.CLIENT_URL ||
            origin.endsWith(".vercel.app") ||
            origin.endsWith(".render.com") ||
            origin.startsWith("http://localhost") ||
            origin.startsWith("http://127.0.0.1");
          if (allowed) {
            callback(null, true);
          } else {
            callback(new Error("Not allowed by Socket CORS"));
          }
        },
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
      } catch (err) {
        next(new Error("Authentication error: Invalid token"));
      }
    });

    this.io.on("connection", (socket: Socket) => {
      const userId = socket.data.user.userId;
      const sessionId = socket.data.user.sessionId;

      // Layered Rate Limiting Middleware (Global + Per-Event)
      socket.use(async ([event, ..._args], next) => {
        // Without Redis the same limits apply from memory (single server); before, they were skipped entirely
        if (!redis) {
          const verdict = this.memoryRateLimit(userId, String(event));
          if (verdict === "ok") return next();
          socket.emit("error", {
            message: verdict === "penalty"
              ? "Too many requests. Temporary suspension in effect."
              : "Rate limit exceeded. Temporary suspension applied."
          });
          return; // Drop event
        }
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
          if (!results) return next();

          // Get counts from ZCARD results
          const globalCount = results[2][1] as number;
          const eventCount = results[5][1] as number;

          if (globalCount > globalLimit || eventCount > perEventLimit) {
            console.warn(`[WS_RATE_LIMIT] User ${userId} exceeded limit (Global: ${globalCount}, Event: ${event}, EventCount: ${eventCount})`);
            
            // Progressive Penalty: 1 minute ban if they keep spamming
            await redis.set(penaltyKey, "1", "EX", 60);
            
            socket.emit("error", { message: "Rate limit exceeded. Temporary suspension applied." });
            return; // Drop event
          }

          next();
        } catch (err) {
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
      // Project rooms carry comment text and files, so only people with access may join
      socket.on("join_project", async (projectId: string) => {
        if (typeof projectId !== "string" || !projectId) return;
        try {
          // Dynamic import: project.service imports this module
          const [{ ProjectService }, { prisma }] = await Promise.all([
            import("./project.service.js"),
            import("../prisma/client.js")
          ]);
          const user = await prisma.user.findFirst({ where: { id: userId, deletedAt: null }, select: { role: true } });
          if (!user) return;
          await ProjectService.assertProjectAccess(projectId, userId, user.role);
          // Members only: someone just assigned a task gets their own updates, not the whole project's
          if (!(await ProjectService.isMember(projectId, userId, user.role))) return;
          socket.join(`project_${projectId}`);
        } catch {
          // No access (or project gone): silently stay out of the room
        }
      });

      socket.on("leave_project", (projectId: string) => {
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
        } else {
          this.userSockets.set(userId, sockets);
        }

        const sessionSockets = this.sessionSockets.get(sessionId) || [];
        const sessionIndex = sessionSockets.indexOf(socket.id);
        if (sessionIndex > -1) {
          sessionSockets.splice(sessionIndex, 1);
        }
        if (sessionSockets.length === 0) {
          this.sessionSockets.delete(sessionId);
        } else {
          this.sessionSockets.set(sessionId, sessionSockets);
        }
      });
    });

    return this.io;
  }

  public getIO(): Server {
    if (!this.io) {
      throw new Error("Socket.io not initialized");
    }
    return this.io;
  }

  public emitToUser(userId: string, event: string, data: any) {
    this.io?.to(`user_${userId}`).emit(event, data);
  }

  public async forceLogoutSessions(sessionIds: string[], message: string) {
    if (!this.io || sessionIds.length === 0) {
      return;
    }

    for (const sessionId of sessionIds) {
      this.io.to(`session_${sessionId}`).emit("force_logout", { message });
      const sockets = await this.io.in(`session_${sessionId}`).fetchSockets();
      sockets.forEach((socket) => socket.disconnect(true));
    }
  }

  public emitToProject(projectId: string, event: string, data: any) {
    this.io?.to(`project_${projectId}`).emit(event, data);
  }

  // People taken off a project stop getting its live events at once (on every server, via the adapter)
  public leaveProject(projectId: string, userIds: string[]) {
    if (userIds.length) this.io?.in(userIds.map((id) => `user_${id}`)).socketsLeave(`project_${projectId}`);
  }

  public closeProject(projectId: string) {
    this.io?.in(`project_${projectId}`).socketsLeave(`project_${projectId}`);
  }

  public emitToAll(event: string, data: any) {
    this.io?.emit(event, data);
  }
}

export const socketService = SocketService.getInstance();
