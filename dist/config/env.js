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
    REDIS_URL: z.string().url().optional()
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
