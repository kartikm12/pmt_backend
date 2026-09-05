import type { Request, Response } from "express";
import { AuthService } from "../services/auth.service.js";

export class AuthController {
  static async register(req: Request, res: Response) {
    const result = await AuthService.register(req.body, {
      userAgent: req.get("user-agent") ?? undefined,
      ipAddress: req.ip
    });
    return res.status(201).json(result);
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
