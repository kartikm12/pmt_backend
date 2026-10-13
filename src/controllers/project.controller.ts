import type { Request, Response } from "express";
import { ProjectService } from "../services/project.service.js";

export class ProjectController {
  static async milestones(req: Request, res: Response) {
    return res.status(200).json(await ProjectService.listMilestones(req.user!.userId, req.user!.role as any));
  }

  static async list(req: Request, res: Response) {
    const projects = await ProjectService.list(req.user!.userId, req.user!.role as any);
    return res.status(200).json(projects);
  }

  static async getById(req: Request, res: Response) {
    const project = await ProjectService.getById(req.params.projectId, req.user!.userId, req.user!.role as any);
    return res.status(200).json(project);
  }

  static async getBundle(req: Request, res: Response) {
    const bundle = await ProjectService.getBundle(req.params.projectId, req.user!.userId, req.user!.role as any);
    return res.status(200).json(bundle);
  }

  static async create(req: Request, res: Response) {
    const project = await ProjectService.create(req.user!.userId, req.user!.role, req.body);
    return res.status(201).json(project);
  }

  static async update(req: Request, res: Response) {
    const project = await ProjectService.update(req.params.projectId, req.user!.userId, req.user!.role, req.body);
    return res.status(200).json(project);
  }

  static async remove(req: Request, res: Response) {
    const result = await ProjectService.archive(req.params.projectId, req.user!.userId, req.user!.role);
    return res.status(200).json(result);
  }

  static async assignMembers(req: Request, res: Response) {
    const project = await ProjectService.assignMembers(req.params.projectId, req.user!.userId, req.user!.role, req.body);
    return res.status(200).json(project);
  }

  static async setMemberRole(req: Request, res: Response) {
    const result = await ProjectService.setMemberRole(req.params.projectId, req.params.userId, req.body.role, req.user!.userId, req.user!.role);
    return res.status(200).json(result);
  }

  static async trash(_req: Request, res: Response) {
    return res.status(200).json(await ProjectService.listTrash());
  }

  static async restore(req: Request, res: Response) {
    return res.status(200).json(await ProjectService.restore(req.params.projectId, req.user!.userId));
  }

  static async createMilestone(req: Request, res: Response) {
    const milestone = await ProjectService.saveMilestone(req.params.projectId, null, req.body, req.user!.userId, req.user!.role);
    return res.status(201).json(milestone);
  }

  static async updateMilestone(req: Request, res: Response) {
    const milestone = await ProjectService.saveMilestone(req.params.projectId, req.params.milestoneId, req.body, req.user!.userId, req.user!.role);
    return res.status(200).json(milestone);
  }

  static async deleteMilestone(req: Request, res: Response) {
    await ProjectService.deleteMilestone(req.params.projectId, req.params.milestoneId, req.user!.userId, req.user!.role);
    return res.status(204).send();
  }

  static async removeMember(req: Request, res: Response) {
    const result = await ProjectService.removeMember(req.params.projectId, req.params.userId, req.user!.userId, req.user!.role);
    return res.status(200).json(result);
  }
}
