import { UserService } from "../services/user.service.js";
import { ApiError } from "../utils/apiError.js";
export class UserController {
    static async updateMe(req, res) {
        const user = await UserService.updateMe(req.user.userId, req.body);
        return res.status(200).json(user);
    }
    static async uploadAvatar(req, res) {
        const file = req.file;
        if (!file) {
            throw new ApiError(400, "No file uploaded");
        }
        const user = await UserService.uploadAvatar(req.user.userId, file);
        return res.status(200).json(user);
    }
    static async updatePassword(req, res) {
        const result = await UserService.updatePassword(req.user.userId, req.body);
        return res.status(200).json(result);
    }
}
