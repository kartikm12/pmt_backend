import type { Request, Response } from "express";
import { CommentService } from "../services/comment.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export class CommentController {
  static async list(req: Request, res: Response) {
    const comments = await CommentService.list(req.params.taskId, req.user!.userId, req.user!.role as any);
    return res.status(200).json(comments);
  }

  static async create(req: Request, res: Response) {
    const { body } = req.body;
    const comment = await CommentService.create(req.params.taskId, req.user!.userId, req.user!.role as any, body);
    return res.status(201).json(comment);
  }

  static async remove(req: Request, res: Response) {
    await CommentService.remove(req.params.commentId, req.user!.userId, req.user!.role as any);
    return res.status(204).send();
  }
}
