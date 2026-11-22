import { config } from "dotenv";
import { PrismaClient } from "@prisma/client";

config(); // read .env first if nothing else has yet (never overrides real environment values)

// How many database connections this server may hold at once. Prisma's own default is (CPU cores x 2 + 1),
// which on a machine with many cores went past Supabase's 15-client limit (session mode): the database then
// refused connections right after sign-in. A fixed number keeps every machine under the limit; set
// DB_CONNECTION_LIMIT to change it, or put connection_limit in DATABASE_URL yourself (that wins).
function withConnectionLimit(url: string | undefined): string | undefined {
  if (!url || /[?&]connection_limit=/.test(url)) return url;
  const limit = Number(process.env.DB_CONNECTION_LIMIT) || 12; // 12 of the 15 measured fastest (22 Nov); leaves room for scripts
  return `${url}${url.includes("?") ? "&" : "?"}connection_limit=${limit}`;
}

export const prisma = new PrismaClient({
  log: ["warn", "error"],
  ...(process.env.DATABASE_URL ? { datasources: { db: { url: withConnectionLimit(process.env.DATABASE_URL) } } } : {}),
  // Left out of every query unless asked for, so lists of people (Team etc.) never reveal it
  omit: { user: { passwordChangedAt: true } }
});
