import type { Request, Response } from "express";
import { TeamService } from "../services/team.service.js";

export class TeamController {
  static async list(_req: Request, res: Response) {
    const team = await TeamService.list();
    return res.status(200).json(team);
  }

  static async pending(_req: Request, res: Response) {
    return res.status(200).json(await TeamService.listPending());
  }

  static async approve(req: Request, res: Response) {
    const member = await TeamService.approve(req.params.userId, req.body.role, { userId: req.user!.userId, role: req.user!.role, fullName: req.user!.fullName });
    return res.status(200).json(member);
  }

  static async reject(req: Request, res: Response) {
    await TeamService.reject(req.params.userId, { userId: req.user!.userId, fullName: req.user!.fullName });
    return res.status(204).send();
  }

  static async invite(req: Request, res: Response) {
    const member = await TeamService.invite(req.user!.userId, req.user!.role, req.body);
    return res.status(201).json(member);
  }

  static async remove(req: Request, res: Response) {
    const result = await TeamService.remove(req.params.userId, req.user!.userId, req.user!.role);
    return res.status(200).json(result);
  }

  static async update(req: Request, res: Response) {
    const member = await TeamService.update(req.params.userId, req.user!.userId, req.user!.role, req.body);
    return res.status(200).json(member);
  }
}
