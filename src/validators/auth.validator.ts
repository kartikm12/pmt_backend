import { z } from "zod";

export const registerSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().email(),
  password: z.string().min(8).max(128)
});

// Any wrong password, however short, must get the same "Invalid email or password" answer
export const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1).max(128)
});
