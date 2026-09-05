import { createServer } from "http";
import { app } from "./app.js";
import { env } from "./config/env.js";
import { prisma } from "./prisma/client.js";
import { socketService } from "./services/socket.service.js";

async function bootstrap() {
  try {
    await prisma.$connect();

    const httpServer = createServer(app);
    await socketService.init(httpServer);

    httpServer.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EADDRINUSE") {
        console.warn(`Port ${env.PORT} is in use, retrying in 1s...`);
        setTimeout(() => {
          httpServer.close();
          httpServer.listen(env.PORT, "0.0.0.0");
        }, 1000);
      } else {
        console.error("HTTP Server Error", e);
      }
    });

    httpServer.listen(env.PORT, "0.0.0.0", () => {
      console.log(`API + WebSocket server running on http://0.0.0.0:${env.PORT}`);
    });

    // Background session cleanup task
    const SESSION_CLEANUP_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
    const sessionCleanupTimer = setInterval(async () => {
      try {
        const deleted = await prisma.userSession.deleteMany({
          where: { expiresAt: { lt: new Date() } }
        });
        if (deleted.count > 0) {
          console.log(`Cleaned up ${deleted.count} expired sessions.`);
        }
      } catch (err) {
        console.error("Session cleanup failed:", err);
      }
    }, SESSION_CLEANUP_INTERVAL);

    const shutdown = async () => {
      console.log("Shutting down gracefully...");
      clearInterval(sessionCleanupTimer);
      httpServer.close();
      await prisma.$disconnect();
      process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (error) {
    console.error("Failed to start server", error);
    process.exit(1);
  }
}

void bootstrap();
