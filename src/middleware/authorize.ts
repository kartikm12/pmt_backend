import type { NextFunction, Request, Response } from "express";
import type { UserRole } from "../constants/enums.js";
import { ApiError } from "../utils/apiError.js";

export function authorize(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new ApiError(401, "Authentication required"));
    }

    if (!roles.includes(req.user.role)) {
      return next(new ApiError(403, `Invalid permission: User role [${req.user.role}] is not in authorized roles [${roles.join(", ")}]`));
    }

    next();
  };
}
