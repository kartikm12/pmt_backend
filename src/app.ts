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
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsDir = path.join(__dirname, "../../frontend/public/uploads");
const distDir = path.join(__dirname, "../../../frontend/dist");

app.use("/uploads", express.static(uploadsDir));

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.use("/api", globalRateLimiter, apiRouter);

// Serve the frontend in production
app.use(express.static(distDir));
app.get("*", (req, res) => {
  res.sendFile(path.join(distDir, "index.html"));
});

app.use(notFound);
app.use(errorHandler);
