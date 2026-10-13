import type { Request, Response } from "express";
import { AuthService } from "../services/auth.service.js";
import { PasswordResetService } from "../services/password-reset.service.js";

export class AuthController {
  static async register(req: Request, res: Response) {
    const result = await AuthService.register(req.body, {
      userAgent: req.get("user-agent") ?? undefined,
      ipAddress: req.ip
    });
    // 202: account saved but not usable yet (waiting for approval)
    return res.status("pending" in result ? 202 : 201).json(result);
  }

  // Same answer whether or not the email has an account, so the form can't be used to probe for accounts
  static async forgotPassword(req: Request, res: Response) {
    await PasswordResetService.request(req.body.email);
    return res.status(200).json({ message: "If that email has an account, we've sent a link to reset the password." });
  }

  static async resetPassword(req: Request, res: Response) {
    await PasswordResetService.reset(req.body.token, req.body.password);
    return res.status(200).json({ message: "Password changed. Sign in with your new password." });
  }

  static async login(req: Request, res: Response) {
    const result = await AuthService.login(req.body, {
      userAgent: req.get("user-agent") ?? undefined,
      ipAddress: req.ip
    });
    return res.status(200).json(result);
  }

  static async me(req: Request, res: Response) {
    const user = await AuthService.me(req.user!.userId);
    return res.status(200).json(user);
  }

  static async logout(req: Request, res: Response) {
    const result = await AuthService.logout(req.user!.sessionId);
    return res.status(200).json(result);
  }
}
