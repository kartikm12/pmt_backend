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
  updateProjectSchema
} from "../validators/project.validator.js";
import { columnsSchema } from "../rules/rule.validator.js";
import { ruleRouter } from "../rules/rule.routes.js";
import { ProjectService } from "../services/project.service.js";

export const projectRouter = Router();

const companyManagers = authorize(USER_ROLE.MANAGER, USER_ROLE.PROJECT_MANAGER, USER_ROLE.ADMIN);

projectRouter.use(authenticate);
projectRouter.get("/", asyncHandler(ProjectController.list));
// Before "/:projectId", which would otherwise swallow "trash"
projectRouter.get("/trash", companyManagers, asyncHandler(ProjectController.trash));
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
// The board's own columns: anyone on the project reads them; the service lets only its managers change them
projectRouter.get("/:projectId/columns", asyncHandler(async (req, res) => {
  res.json(await ProjectService.getColumns(req.params.projectId, req.user!.userId, req.user!.role as any));
}));
projectRouter.put("/:projectId/columns", validate(columnsSchema), asyncHandler(async (req, res) => {
  res.json(await ProjectService.saveColumns(req.params.projectId, req.body, req.user!.userId, req.user!.role as any));
}));
// "When ... then ..." rules
projectRouter.use("/:projectId/rules", ruleRouter);
