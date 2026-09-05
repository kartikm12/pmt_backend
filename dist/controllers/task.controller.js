import { TaskService } from "../services/task.service.js";
export class TaskController {
    static async list(req, res) {
        const tasks = await TaskService.list(req.user.userId, req.user.role, req.query.projectId);
        return res.status(200).json(tasks);
    }
    static async getById(req, res) {
        const task = await TaskService.getById(req.params.taskId, req.user.userId, req.user.role);
        return res.status(200).json(task);
    }
    static async create(req, res) {
        const task = await TaskService.create(req.user.userId, req.body);
        return res.status(201).json(task);
    }
    static async update(req, res) {
        const task = await TaskService.update(req.params.taskId, req.user.userId, req.user.role, req.body);
        return res.status(200).json(task);
    }
    static async remove(req, res) {
        const result = await TaskService.remove(req.params.taskId, req.user.userId);
        return res.status(200).json(result);
    }
}
