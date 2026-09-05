import { Router } from "express";
import { USER_ROLE } from "../constants/enums.js";
import { ProjectController } from "../controllers/project.controller.js";
import { authenticate } from "../middleware/authenticate.js";
import { authorize } from "../middleware/authorize.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import {
  assignMembersSchema,
  createProjectSchema,
  updateProjectSchema
} from "../validators/project.validator.js";

export const projectRouter = Router();

projectRouter.use(authenticate);
projectRouter.get("/", asyncHandler(ProjectController.list));
projectRouter.get("/:projectId", asyncHandler(ProjectController.getById));
projectRouter.get("/:projectId/bundle", asyncHandler(ProjectController.getBundle));
projectRouter.post("/", authorize(USER_ROLE.MANAGER, USER_ROLE.PROJECT_MANAGER, USER_ROLE.ADMIN), validate(createProjectSchema), asyncHandler(ProjectController.create));
projectRouter.put("/:projectId", authorize(USER_ROLE.MANAGER, USER_ROLE.PROJECT_MANAGER, USER_ROLE.ADMIN), validate(updateProjectSchema), asyncHandler(ProjectController.update));
projectRouter.delete("/:projectId", authorize(USER_ROLE.MANAGER, USER_ROLE.PROJECT_MANAGER, USER_ROLE.ADMIN), asyncHandler(ProjectController.remove));
projectRouter.post(
  "/:projectId/members",
  authorize(USER_ROLE.MANAGER, USER_ROLE.PROJECT_MANAGER, USER_ROLE.ADMIN),
  validate(assignMembersSchema),
  asyncHandler(ProjectController.assignMembers)
);
projectRouter.delete(
  "/:projectId/members/:userId",
  authorize(USER_ROLE.MANAGER, USER_ROLE.PROJECT_MANAGER, USER_ROLE.ADMIN),
  asyncHandler(ProjectController.removeMember)
);
