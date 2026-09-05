import { CommentService } from "../services/comment.service.js";
export class CommentController {
    static async list(req, res) {
        const comments = await CommentService.list(req.params.taskId, req.user.userId, req.user.role);
        return res.status(200).json(comments);
    }
    static async create(req, res) {
        const { body } = req.body;
        const comment = await CommentService.create(req.params.taskId, req.user.userId, req.user.role, body);
        return res.status(201).json(comment);
    }
    static async remove(req, res) {
        await CommentService.remove(req.params.commentId, req.user.userId, req.user.role);
        return res.status(204).send();
    }
}
