import { Request, Response } from "express";
import { checkFileLink, withFileLink } from "../utils/fileLink.js";
import { AttachmentService } from "../services/attachment.service.js";
import { ApiError } from "../utils/apiError.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { StorageService } from "../services/storage.service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class AttachmentController {
  static async upload(req: Request, res: Response) {
    const file = req.file;
    const { projectId, taskId } = req.body;
    const user = req.user!;

    if (!file) {
      throw new ApiError(400, "No file uploaded");
    }

    // Check access (and that viewers can't upload) before anything reaches storage
    const finalProjectId = await AttachmentService.assertCanUpload({ projectId, taskId, userId: user.userId, role: user.role as any });

    const fileUrl = await StorageService.uploadPrivateFile(file.buffer, file.originalname, file.mimetype);

    try {
      const attachment = await AttachmentService.create({
        name: file.originalname,
        url: fileUrl,
        fileType: file.mimetype,
        fileSize: file.size,
        projectId: finalProjectId,
        taskId: taskId || null,
        userId: user.userId,
        role: user.role as any
      });

      res.status(201).json(withFileLink(attachment));
    } catch (error) {
      await StorageService.deleteFile(fileUrl); // don't leave an orphan file in the bucket
      throw error;
    }
  }

  // Opened straight from a link (no sign-in header), so the link's own signature is the check
  static async file(req: Request, res: Response) {
    res.setHeader("Cache-Control", "no-store");
    const check = checkFileLink(req.params.id, req.query.exp, req.query.sig);
    if (check !== "ok") {
      return res.status(check === "expired" ? 410 : 403).type("text/plain")
        .send(check === "expired" ? "This file link has expired. Open the file again from PMT." : "This file link isn't valid. Open the file from PMT.");
    }
    const attachment = await AttachmentService.getById(req.params.id);
    if (!attachment) return res.status(404).type("text/plain").send("This file was deleted.");
    // ?size=thumb: the small version of a picture (made on first request); anything else gets the original
    if (req.query.size === "thumb" && attachment.fileType.startsWith("image/")) {
      const thumb = await StorageService.openThumbUrl(attachment.url);
      if (thumb) {
        // The browser may reuse this for 50 minutes: shorter than the storage link it points to (1 hour)
        res.setHeader("Cache-Control", "private, max-age=3000");
        return res.redirect(302, thumb);
      }
    }
    return res.redirect(302, await StorageService.openUrl(attachment.url));
  }

  static async list(req: Request, res: Response) {
    const { projectId, taskId } = req.query;
    const attachments = await AttachmentService.list({
      projectId: projectId as string,
      taskId: taskId as string,
      userId: req.user!.userId,
      role: req.user!.role as any
    });
    res.json(attachments);
  }

  static async remove(req: Request, res: Response) {
    const { id } = req.params;
    const attachment = await AttachmentService.getById(id);

    if (!attachment) {
      throw new ApiError(404, "Attachment not found");
    }

    await AttachmentService.delete(id, req.user!.userId, req.user!.role as any);

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
