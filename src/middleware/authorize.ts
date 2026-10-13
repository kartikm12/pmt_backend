import type { NextFunction, Request, Response } from "express";
import type { UserRole } from "../constants/enums.js";
import { ApiError } from "../utils/apiError.js";

export function authorize(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new ApiError(401, "Authentication required"));
    }

    if (!roles.includes(req.user.role)) {
      // Shown to people as-is, so plain words; the role list stays out of the UI
      return next(new ApiError(403, "Your role doesn't allow this. Ask a manager if you need it."));
    }

    next();
  };
}
