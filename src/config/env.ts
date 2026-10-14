import { config } from "dotenv";
import { z } from "zod";

config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_EXPIRES_IN: z.string().default("7d"),
  CLIENT_URL: z.string().url().default("http://localhost:3000"),
  BCRYPT_ROUNDS: z.coerce.number().int().min(8).max(15).default(10),
  // An empty value (e.g. cleared on the hosting dashboard) means "no Redis", not a crash at startup
  REDIS_URL: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().url().optional()),
  // Email through Brevo's HTTPS API (used when set), else Resend's; without either, emails go to mail-outbox.jsonl
  BREVO_API_KEY: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().optional()),
  RESEND_API_KEY: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().optional()),
  // "Name <address>"; the address must be a verified sender in Brevo (or a verified domain in Resend)
  MAIL_FROM: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().default("PMT <xzen347@gmail.com>")),
  // The site people open (for links in emails); falls back to CLIENT_URL
  APP_URL: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().url().optional()),
  // Proxy hops in front of the app (Render's load balancer = 1). Without it every user shares the proxy's IP,
  // so one person hitting a rate limit blocks everyone. Set 0 only when the app is reached directly.
  TRUST_PROXY: z.coerce.number().int().min(0).default(1)
}).refine(data => {
  const weakSecrets = [
    "your_super_secret_jwt_key_change_in_production",
    "your-secret-key",
    "secret",
    "change_this_secret"
  ];
  if (data.NODE_ENV === "production" && weakSecrets.includes(data.JWT_SECRET)) {
    return false;
  }
  return true;
}, {
  message: "JWT_SECRET must be securely generated in production",
  path: ["JWT_SECRET"]
});

export const env = envSchema.parse(process.env);
