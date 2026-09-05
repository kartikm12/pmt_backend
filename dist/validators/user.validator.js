import { z } from "zod";
export const updateMeSchema = z.object({
    fullName: z.string().optional(),
    email: z.string().email().optional(),
    bio: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    avatarUrl: z.string().nullable().optional()
}).strict();
export const updatePasswordSchema = z.object({
    currentPassword: z.string().min(8).max(128),
    newPassword: z.string().min(8).max(128)
});
