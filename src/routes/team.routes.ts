import { Router } from "express";
import { USER_ROLE } from "../constants/enums.js";
import { TeamController } from "../controllers/team.controller.js";
import { authenticate } from "../middleware/authenticate.js";
import { authorize } from "../middleware/authorize.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { inviteTeamMemberSchema } from "../validators/team.validator.js";

export const teamRouter = Router();

teamRouter.use(authenticate);
teamRouter.get("/", asyncHandler(TeamController.list));
teamRouter.post("/", authorize(USER_ROLE.MANAGER, USER_ROLE.PROJECT_MANAGER, USER_ROLE.ADMIN), validate(inviteTeamMemberSchema), asyncHandler(TeamController.invite));
teamRouter.patch("/:userId", authorize(USER_ROLE.MANAGER, USER_ROLE.PROJECT_MANAGER, USER_ROLE.ADMIN), asyncHandler(TeamController.update));
teamRouter.delete("/:userId", authorize(USER_ROLE.MANAGER, USER_ROLE.PROJECT_MANAGER, USER_ROLE.ADMIN), asyncHandler(TeamController.remove));
