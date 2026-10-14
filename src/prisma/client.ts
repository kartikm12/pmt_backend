import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient({
  log: ["warn", "error"],
  // Left out of every query unless asked for, so lists of people (Team etc.) never reveal it
  omit: { user: { passwordChangedAt: true } }
});
