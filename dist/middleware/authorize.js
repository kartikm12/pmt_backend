import { ApiError } from "../utils/apiError.js";
export function authorize(...roles) {
    return (req, _res, next) => {
        if (!req.user) {
            return next(new ApiError(401, "Authentication required"));
        }
        if (!roles.includes(req.user.role)) {
            return next(new ApiError(403, `Invalid permission: User role [${req.user.role}] is not in authorized roles [${roles.join(", ")}]`));
        }
        next();
    };
}
