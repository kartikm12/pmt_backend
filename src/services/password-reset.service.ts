import { createHash, randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import { env } from "../config/env.js";
import { prisma } from "../prisma/client.js";
import { ApiError } from "../utils/apiError.js";
import { MailService } from "../mail/mail.service.js";
import { socketService } from "./socket.service.js";
import { ActivityService } from "./activity.service.js";

const LINK_MINUTES = 60;
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

// "Forgot password": a single-use link, valid for an hour. Only the token's hash is stored, so a database
// leak can't be turned into password resets, and the answer is the same whether or not the email exists.
export class PasswordResetService {
  static async request(email: string) {
    const user = await prisma.user.findFirst({
      where: { email: email.trim().toLowerCase(), deletedAt: null, pendingApproval: false, status: { not: "SUSPENDED" } },
      select: { id: true, fullName: true, email: true }
    });
    if (!user) return;

    // Asking again replaces any earlier link
    const token = randomBytes(32).toString("base64url");
    await prisma.$transaction([
      prisma.passwordResetToken.deleteMany({ where: { userId: user.id, usedAt: null } }),
      prisma.passwordResetToken.create({ data: { userId: user.id, tokenHash: hash(token), expiresAt: new Date(Date.now() + LINK_MINUTES * 60_000) } })
    ]);
    void MailService.send({
      to: user.email,
      subject: "Reset your PMT password",
      heading: "Reset your password",
      body: `Hi ${user.fullName},\n\nSomeone (hopefully you) asked to reset your PMT password. The link works once and for the next ${LINK_MINUTES} minutes.\n\nIf you didn't ask, ignore this email: your password stays the same.`,
      button: { label: "Choose a new password", url: MailService.appUrl(`/reset-password?token=${token}`) }
    });
  }

  static async reset(token: string, newPassword: string) {
    const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hash(token) } });
    if (!record || record.usedAt || record.expiresAt <= new Date()) {
      throw new ApiError(400, "This reset link has expired or was already used. Ask for a new one.");
    }
    const user = await prisma.user.findFirst({ where: { id: record.userId, deletedAt: null }, select: { id: true, fullName: true } });
    if (!user) throw new ApiError(400, "This reset link has expired or was already used. Ask for a new one.");

    const passwordHash = await bcrypt.hash(newPassword, env.BCRYPT_ROUNDS);
    const now = new Date();
    // New password, link spent, and every signed-in device signed out (whoever had the old password)
    const active = await prisma.userSession.findMany({ where: { userId: user.id, isActive: true }, select: { id: true } });
    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { passwordHash } }),
      prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: now } }),
      prisma.userSession.updateMany({ where: { userId: user.id, isActive: true }, data: { isActive: false, revokedAt: now, revokedReason: "PASSWORD_RESET" } })
    ]);
    await socketService.forceLogoutSessions(active.map((s) => s.id), "Your password was changed. Please sign in again.");
    await ActivityService.log({ action: "PROFILE_UPDATED", entityType: "user", entityId: user.id, description: `${user.fullName} reset their password by email`, userId: user.id });
  }
}
