import { TeamService } from "../services/team.service.js";
export class TeamController {
    static async list(_req, res) {
        const team = await TeamService.list();
        return res.status(200).json(team);
    }
    static async invite(req, res) {
        const member = await TeamService.invite(req.user.userId, req.body);
        return res.status(201).json(member);
    }
    static async remove(req, res) {
        const result = await TeamService.remove(req.params.userId, req.user.userId);
        return res.status(200).json(result);
    }
    static async update(req, res) {
        const member = await TeamService.update(req.params.userId, req.user.userId, req.body);
        return res.status(200).json(member);
    }
}
