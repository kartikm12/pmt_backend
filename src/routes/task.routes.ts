import { Router } from "express";
import { USER_ROLE } from "../constants/enums.js";
import { TaskController } from "../controllers/task.controller.js";
import { CommentController } from "../controllers/comment.controller.js";
import { authenticate } from "../middleware/authenticate.js";
import { authorize } from "../middleware/authorize.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { createCommentSchema, createTaskSchema, updateTaskSchema } from "../validators/task.validator.js";

export const taskRouter = Router();

taskRouter.use(authenticate);
taskRouter.get("/", asyncHandler(TaskController.list));
taskRouter.get("/:taskId", asyncHandler(TaskController.getById));
taskRouter.post("/", authorize(USER_ROLE.MANAGER, USER_ROLE.PROJECT_MANAGER, USER_ROLE.ADMIN), validate(createTaskSchema), asyncHandler(TaskController.create));
// FIX (HIGH #4): Explicit role authorization on task update.
// All authenticated roles are allowed, but the service enforces
// deeper per-role rules (non-managers can only change status).
taskRouter.put(
  "/:taskId",
  authorize(
    USER_ROLE.ADMIN,
    USER_ROLE.MANAGER,
    USER_ROLE.PROJECT_MANAGER,
    USER_ROLE.DEVELOPER,
    USER_ROLE.DESIGNER,
    USER_ROLE.TESTER,
    USER_ROLE.SUPPORT_ENGINEER,
    USER_ROLE.BUSINESS_ANALYST,
    USER_ROLE.TEAM_MEMBER
  ),
  validate(updateTaskSchema),
  asyncHandler(TaskController.update)
);

taskRouter.delete("/:taskId", authorize(USER_ROLE.MANAGER, USER_ROLE.PROJECT_MANAGER, USER_ROLE.ADMIN), asyncHandler(TaskController.remove));

// Task Comments
taskRouter.get("/:taskId/comments", asyncHandler(CommentController.list));
taskRouter.post("/:taskId/comments", validate(createCommentSchema), asyncHandler(CommentController.create));
taskRouter.patch("/comments/:commentId", validate(createCommentSchema), asyncHandler(CommentController.update));
taskRouter.delete("/comments/:commentId", asyncHandler(CommentController.remove));
