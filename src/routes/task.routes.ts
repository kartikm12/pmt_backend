import { Router } from "express";
import { USER_ROLE } from "../constants/enums.js";
import { TaskController } from "../controllers/task.controller.js";
import { CommentController } from "../controllers/comment.controller.js";
import { authenticate } from "../middleware/authenticate.js";
import { authorize } from "../middleware/authorize.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import {
  createCommentSchema,
  createTaskSchema,
  reorderSchema,
  subtaskSchema,
  timeEntrySchema,
  updateTaskSchema
} from "../validators/task.validator.js";

export const taskRouter = Router();

taskRouter.use(authenticate);
taskRouter.get("/", asyncHandler(TaskController.list));
taskRouter.get("/repeat-preview", asyncHandler(TaskController.repeatPreview));
// Fixed paths first so "/:taskId" doesn't swallow them
taskRouter.post("/reorder", validate(reorderSchema), asyncHandler(TaskController.reorder));
taskRouter.patch("/subtasks/:subtaskId", validate(subtaskSchema.partial()), asyncHandler(TaskController.updateSubtask));
taskRouter.delete("/subtasks/:subtaskId", asyncHandler(TaskController.removeSubtask));
taskRouter.delete("/time/:entryId", asyncHandler(TaskController.removeTime));
taskRouter.patch("/comments/:commentId", validate(createCommentSchema), asyncHandler(CommentController.update));
taskRouter.delete("/comments/:commentId", asyncHandler(CommentController.remove));

taskRouter.get("/:taskId", asyncHandler(TaskController.getById));
// Create / edit / delete: the service checks the person's role in the task's project
taskRouter.post("/", validate(createTaskSchema), asyncHandler(TaskController.create));
taskRouter.put("/:taskId", validate(updateTaskSchema), asyncHandler(TaskController.update));
taskRouter.delete("/:taskId", asyncHandler(TaskController.remove));
taskRouter.post(
  "/:taskId/restore",
  authorize(USER_ROLE.MANAGER, USER_ROLE.PROJECT_MANAGER, USER_ROLE.ADMIN),
  asyncHandler(TaskController.restore)
);
taskRouter.post("/:taskId/watch", asyncHandler(TaskController.watch));
taskRouter.delete("/:taskId/watch", asyncHandler(TaskController.unwatch));
taskRouter.post("/:taskId/subtasks", validate(subtaskSchema), asyncHandler(TaskController.addSubtask));
taskRouter.post("/:taskId/time", validate(timeEntrySchema), asyncHandler(TaskController.logTime));

// Task Comments
taskRouter.get("/:taskId/comments", asyncHandler(CommentController.list));
taskRouter.post("/:taskId/comments", validate(createCommentSchema), asyncHandler(CommentController.create));
