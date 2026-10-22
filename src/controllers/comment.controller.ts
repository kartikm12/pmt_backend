import type { Request, Response } from "express";
import { CommentService } from "../services/comment.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/apiError.js";

export class CommentController {
  static async list(req: Request, res: Response) {
    const comments = await CommentService.list(req.params.taskId, req.user!.userId, req.user!.role as any);
    return res.status(200).json(comments);
  }

  static async create(req: Request, res: Response) {
    const body: string = req.body.body ?? "";
    const files = (Array.isArray(req.files) ? req.files : []) as Express.Multer.File[];
    if (!body.trim() && !files.length) throw new ApiError(400, "Write a comment or attach a file");
    const comment = await CommentService.create(req.params.taskId, req.user!.userId, req.user!.role as any, body, files);
    return res.status(201).json(comment);
  }

  static async update(req: Request, res: Response) {
    const comment = await CommentService.update(req.params.commentId, req.user!.userId, req.user!.role as any, req.body.body);
    return res.status(200).json(comment);
  }

  static async remove(req: Request, res: Response) {
    await CommentService.remove(req.params.commentId, req.user!.userId, req.user!.role as any);
    return res.status(204).send();
  }
}
