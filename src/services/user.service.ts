import bcrypt from "bcryptjs";
import { env } from "../config/env.js";
import { prisma } from "../prisma/client.js";
import { ApiError } from "../utils/apiError.js";
import { ActivityService } from "./activity.service.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { StorageService } from "./storage.service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class UserService {
  static async updateMe(
    userId: string,
    input: {
      fullName?: string;
      email?: string;
      bio?: string | null;
      phone?: string | null;
      title?: string | null;
      avatarUrl?: string | null;
      emailNotifications?: boolean;
    }
  ) {
    const existingUser = await prisma.user.findFirst({
      where: { id: userId, deletedAt: null }
    });

    if (!existingUser) {
      throw new ApiError(404, "User not found");
    }

    if (input.email && input.email !== existingUser.email) {
      const emailTaken = await prisma.user.findFirst({
        // Removed members still hold their email (soft delete), so don't filter on deletedAt
        where: {
          email: input.email,
          id: { not: userId }
        }
      });

      if (emailTaken) {
        // FIX (HIGH #6): Do NOT leak other user's name or ID in the error message.
        throw new ApiError(409, "Email is already in use");
      }
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        fullName: input.fullName,
        email: input.email,
        bio: input.bio === undefined ? undefined : input.bio,
        phone: input.phone === undefined ? undefined : input.phone,
        title: input.title === undefined ? undefined : input.title,
        avatarUrl: input.avatarUrl === undefined ? undefined : input.avatarUrl,
        emailNotifications: input.emailNotifications
      }
    });

    if (input.avatarUrl === null && existingUser.avatarUrl) {
      await StorageService.deleteFile(existingUser.avatarUrl);
    }

    const { passwordHash: _, ...userWithoutPassword } = user;

    await ActivityService.log({
      action: "PROFILE_UPDATED",
      entityType: "user",
      entityId: userId,
      description: `${user.fullName} updated profile`,
      userId
    });

    return { ...userWithoutPassword, roleLocked: (user as any).roleLocked };
  }

  static async updatePassword(
    userId: string,
    input: {
      currentPassword: string;
      newPassword: string;
    }
  ) {
    const user = await prisma.user.findFirst({
      where: { id: userId, deletedAt: null }
    });

    if (!user) {
      throw new ApiError(404, "User not found");
    }

    const isCurrentPasswordValid = await bcrypt.compare(input.currentPassword, user.passwordHash);
    if (!isCurrentPasswordValid) {
      throw new ApiError(400, "Current password is incorrect");
    }

    const isSamePassword = await bcrypt.compare(input.newPassword, user.passwordHash);
    if (isSamePassword) {
      throw new ApiError(400, "New password must be different from current password");
    }

    const passwordHash = await bcrypt.hash(input.newPassword, env.BCRYPT_ROUNDS);

    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash, passwordChangedAt: new Date() }
    });

    await ActivityService.log({
      action: "PROFILE_UPDATED",
      entityType: "user",
      entityId: userId,
      description: `${user.fullName} changed password`,
      userId
    });

    return { success: true };
  }

  static async uploadAvatar(userId: string, file: Express.Multer.File) {
    const existingUser = await prisma.user.findFirst({
      where: { id: userId, deletedAt: null }
    });

    if (!existingUser) {
      throw new ApiError(404, "User not found");
    }

    // Upload first: if storage fails, the user keeps their current photo
    const avatarUrl = await StorageService.uploadFile(file.buffer, file.originalname, file.mimetype, 'avatars');

    // Then delete the old avatar file (local legacy upload or Supabase)
    if (existingUser.avatarUrl && existingUser.avatarUrl.startsWith("/uploads/")) {
      const oldRelativePath = existingUser.avatarUrl.replace(/^\/+/, "");
      const oldFilePath = path.join(__dirname, "../../public", oldRelativePath);
      try {
        if (fs.existsSync(oldFilePath)) {
          fs.unlinkSync(oldFilePath);
        }
      } catch (err) {
        console.error("Failed to delete old avatar file", err);
      }
    } else if (existingUser.avatarUrl && existingUser.avatarUrl.includes("supabase.co")) {
      await StorageService.deleteFile(existingUser.avatarUrl);
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: { avatarUrl }
    });

    const { passwordHash: _, ...userWithoutPassword } = user;

    await ActivityService.log({
      action: "PROFILE_UPDATED",
      entityType: "user",
      entityId: userId,
      description: `${user.fullName} updated profile photo`,
      userId
    });

    return { ...userWithoutPassword, roleLocked: (user as any).roleLocked };
  }
}
