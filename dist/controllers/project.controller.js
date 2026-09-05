import { ProjectService } from "../services/project.service.js";
export class ProjectController {
    static async list(req, res) {
        const projects = await ProjectService.list(req.user.userId, req.user.role);
        return res.status(200).json(projects);
    }
    static async getById(req, res) {
        const project = await ProjectService.getById(req.params.projectId, req.user.userId, req.user.role);
        return res.status(200).json(project);
    }
    static async getBundle(req, res) {
        const bundle = await ProjectService.getBundle(req.params.projectId, req.user.userId, req.user.role);
        return res.status(200).json(bundle);
    }
    static async create(req, res) {
        const project = await ProjectService.create(req.user.userId, req.user.role, req.body);
        return res.status(201).json(project);
    }
    static async update(req, res) {
        const project = await ProjectService.update(req.params.projectId, req.user.userId, req.user.role, req.body);
        return res.status(200).json(project);
    }
    static async remove(req, res) {
        const result = await ProjectService.archive(req.params.projectId, req.user.userId, req.user.role);
        return res.status(200).json(result);
    }
    static async assignMembers(req, res) {
        const project = await ProjectService.assignMembers(req.params.projectId, req.user.userId, req.user.role, req.body);
        return res.status(200).json(project);
    }
    static async removeMember(req, res) {
        const result = await ProjectService.removeMember(req.params.projectId, req.params.userId, req.user.userId, req.user.role);
        return res.status(200).json(result);
    }
}
