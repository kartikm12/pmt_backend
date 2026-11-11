import { Router } from "express";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { RuleService } from "./rule.service.js";
import { ruleSchema, ruleToggleSchema } from "./rule.validator.js";
import type { UserRole } from "../constants/enums.js";

// Mounted at /projects/:projectId/rules (after authenticate). Anyone on the project can read the rules;
// the service lets only that project's managers and company Admins/managers change them.
export const ruleRouter = Router({ mergeParams: true });
const who = (req: { user?: { userId: string; role: string } }) => [req.user!.userId, req.user!.role as UserRole] as const;

ruleRouter.get("/", asyncHandler(async (req, res) => {
  res.json(await RuleService.list(req.params.projectId, ...who(req)));
}));
ruleRouter.post("/", validate(ruleSchema), asyncHandler(async (req, res) => {
  res.status(201).json(await RuleService.create(req.params.projectId, req.body, ...who(req)));
}));
ruleRouter.put("/:ruleId", validate(ruleSchema), asyncHandler(async (req, res) => {
  res.json(await RuleService.update(req.params.projectId, req.params.ruleId, req.body, ...who(req)));
}));
ruleRouter.patch("/:ruleId", validate(ruleToggleSchema), asyncHandler(async (req, res) => {
  res.json(await RuleService.setEnabled(req.params.projectId, req.params.ruleId, req.body.enabled, ...who(req)));
}));
ruleRouter.delete("/:ruleId", asyncHandler(async (req, res) => {
  res.json(await RuleService.remove(req.params.projectId, req.params.ruleId, ...who(req)));
}));
