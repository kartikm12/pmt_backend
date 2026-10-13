import cors from "cors";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./config/env.js";
import { errorHandler, notFound } from "./middleware/errorHandler.js";
import { apiRouter } from "./routes/index.js";
import { globalRateLimiter } from "./middleware/rateLimit.js";

export const app = express();
// Rate limits are per user IP; behind the hosting proxy that IP comes from X-Forwarded-For
app.set("trust proxy", env.TRUST_PROXY);

app.use(
  cors({
    origin: (origin, callback) => {
      // In development, allow all origins
      if (env.NODE_ENV === "development" || !origin) {
        callback(null, true);
      } else {
        const allowedList = [
          env.CLIENT_URL,
          "http://localhost:3000",
          "http://127.0.0.1:3000",
          "http://localhost:5173",
          "http://127.0.0.1:5173"
        ].filter(Boolean);

        const isAllowed =
          allowedList.includes(origin) ||
          origin.endsWith(".vercel.app") ||
          origin.endsWith(".render.com") ||
          origin.match(/^http:\/\/(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/);

        if (isAllowed) {
          callback(null, true);
        } else {
          console.error(`[CORS_ERROR] Origin ${origin} is not allowed by policy`);
          callback(new Error("Not allowed by CORS"));
        }
      }
    },
    credentials: true
  })
);
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(morgan("dev"));
// Files go through multer (10 MB); JSON bodies here are small forms
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ limit: "1mb", extended: true }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Legacy local uploads live in this repo's public/uploads (same path from src/ and dist/)
const uploadsDir = path.join(__dirname, "../public/uploads");
const distDir = path.join(__dirname, "../../../frontend/dist");

app.use("/uploads", express.static(uploadsDir));

app.get("/health", async (_req, res) => {
  try {
    const { prisma } = await import("./prisma/client.js");
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: "ok", db: "connected", timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: "error", db: "unreachable", timestamp: new Date().toISOString() });
  }
});

app.use("/api", globalRateLimiter, apiRouter);
// Unknown API paths must 404 here, before the dev-only SPA catch-all below turns them into a 500
app.use("/api", notFound);

// Only serve the frontend locally (in production, frontend is on Vercel)
if (env.NODE_ENV !== "production") {
  app.use(express.static(distDir));
  app.get("*", (req, res) => {
    res.sendFile(path.join(distDir, "index.html"));
  });
}

app.use(notFound);
app.use(errorHandler);
