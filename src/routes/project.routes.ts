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
  memberRoleSchema,
  milestoneSchema,
  updateProjectSchema
} from "../validators/project.validator.js";

export const projectRouter = Router();

const companyManagers = authorize(USER_ROLE.MANAGER, USER_ROLE.PROJECT_MANAGER, USER_ROLE.ADMIN);

projectRouter.use(authenticate);
projectRouter.get("/", asyncHandler(ProjectController.list));
// Before "/:projectId", which would otherwise swallow "trash"
projectRouter.get("/trash", companyManagers, asyncHandler(ProjectController.trash));
projectRouter.get("/milestones", asyncHandler(ProjectController.milestones));
projectRouter.get("/:projectId", asyncHandler(ProjectController.getById));
projectRouter.get("/:projectId/bundle", asyncHandler(ProjectController.getBundle));
projectRouter.post("/", companyManagers, validate(createProjectSchema), asyncHandler(ProjectController.create));
projectRouter.post("/:projectId/restore", companyManagers, asyncHandler(ProjectController.restore));
// Editing, deleting and membership: the service checks the person's role in THIS project
projectRouter.put("/:projectId", validate(updateProjectSchema), asyncHandler(ProjectController.update));
projectRouter.delete("/:projectId", asyncHandler(ProjectController.remove));
projectRouter.post("/:projectId/members", validate(assignMembersSchema), asyncHandler(ProjectController.assignMembers));
projectRouter.patch("/:projectId/members/:userId", validate(memberRoleSchema), asyncHandler(ProjectController.setMemberRole));
projectRouter.delete("/:projectId/members/:userId", asyncHandler(ProjectController.removeMember));
projectRouter.post("/:projectId/milestones", validate(milestoneSchema), asyncHandler(ProjectController.createMilestone));
projectRouter.patch("/:projectId/milestones/:milestoneId", validate(milestoneSchema.partial()), asyncHandler(ProjectController.updateMilestone));
projectRouter.delete("/:projectId/milestones/:milestoneId", asyncHandler(ProjectController.deleteMilestone));
