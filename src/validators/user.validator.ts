import { z } from "zod";

export const updateMeSchema = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  // Login lower-cases the email, so it must be stored lower-case too
  email: z.string().trim().toLowerCase().email().optional(),
  bio: z.string().max(2000).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  title: z.string().max(120).nullable().optional(),
  // Photos are set via the upload endpoint; this field can only clear one
  avatarUrl: z.null().optional(),
  emailNotifications: z.boolean().optional()
}).strict();

export const updatePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8).max(128)
});
