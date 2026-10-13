import type { Request, Response } from "express";
import { UserService } from "../services/user.service.js";
import { ApiError } from "../utils/apiError.js";

export class UserController {
  static async updateMe(req: Request, res: Response) {
    const user = await UserService.updateMe(req.user!.userId, req.body);
    return res.status(200).json(user);
  }

  static async uploadAvatar(req: Request, res: Response) {
    const file = req.file;
    if (!file) {
      throw new ApiError(400, "No file uploaded");
    }
    // The shared upload filter also allows documents; a profile photo must be an image
    if (!file.mimetype.startsWith("image/")) {
      throw new ApiError(400, "Profile photo must be an image (PNG, JPG, GIF or WebP)");
    }
    const user = await UserService.uploadAvatar(req.user!.userId, file);
    return res.status(200).json(user);
  }

  static async updatePassword(req: Request, res: Response) {
    const result = await UserService.updatePassword(req.user!.userId, req.body);
    return res.status(200).json(result);
  }
}
