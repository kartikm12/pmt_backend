import { AttachmentService } from "../services/attachment.service.js";
import { TaskService } from "../services/task.service.js";
import { ApiError } from "../utils/apiError.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { StorageService } from "../services/storage.service.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export class AttachmentController {
    static async upload(req, res) {
        const file = req.file;
        const { projectId, taskId } = req.body;
        const user = req.user;
        if (!file) {
            throw new ApiError(400, "No file uploaded");
        }
        try {
            let finalProjectId = projectId;
            if (!finalProjectId && taskId) {
                const task = await TaskService.getById(taskId, user.userId, user.role);
                finalProjectId = task.projectId;
            }
            const fileUrl = await StorageService.uploadFile(file.buffer, file.originalname, file.mimetype, 'attachments');
            const attachment = await AttachmentService.create({
                name: file.originalname,
                url: fileUrl,
                fileType: file.mimetype,
                fileSize: file.size,
                projectId: finalProjectId || null,
                taskId: taskId || null,
                userId: user.userId,
                role: user.role
            });
            res.status(201).json(attachment);
        }
        catch (error) {
            throw error;
        }
    }
    static async list(req, res) {
        const { projectId, taskId } = req.query;
        const attachments = await AttachmentService.list({
            projectId: projectId,
            taskId: taskId,
            userId: req.user.userId,
            role: req.user.role
        });
        res.json(attachments);
    }
    static async remove(req, res) {
        const { id } = req.params;
        const attachment = await AttachmentService.getById(id);
        if (!attachment) {
            throw new ApiError(404, "Attachment not found");
        }
        await AttachmentService.delete(id, req.user.userId, req.user.role);
        // Delete remote file
        await StorageService.deleteFile(attachment.url);
        // Try deleting local file just in case it's an old one
        if (!attachment.url.startsWith('http')) {
            const relativeUrl = attachment.url.replace(/^\/+/, "");
            const filePath = path.join(__dirname, "../../public", relativeUrl);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        }
        res.json({ success: true });
    }
}
