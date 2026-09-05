import { Redis } from "ioredis";
import { env } from "../config/env.js";

class RedisService {
  private static instance: Redis | null = null;
  private static isAvailable: boolean = false;

  public static getInstance(): Redis | null {
    if (!this.instance && env.REDIS_URL) {
      try {
        this.instance = new Redis(env.REDIS_URL, {
          maxRetriesPerRequest: 1,
          enableReadyCheck: true,
          lazyConnect: true,
          connectTimeout: 5000,
        });

        this.instance.on("error", (err) => {
          console.warn("Redis connection error (rate limiting fallback to memory):", err.message);
          this.isAvailable = false;
        });

        this.instance.on("connect", () => {
          console.log("Redis connected successfully for rate limiting");
          this.isAvailable = true;
        });
      } catch (err) {
        console.warn("Failed to initialize Redis client:", err);
        this.instance = null;
      }
    }
    return this.instance;
  }
}

export const redis = RedisService.getInstance();
