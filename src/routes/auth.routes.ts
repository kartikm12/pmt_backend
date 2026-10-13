import { Router } from "express";
import { AuthController } from "../controllers/auth.controller.js";
import { authenticate } from "../middleware/authenticate.js";
import { loginRateLimiter, registerRateLimiter } from "../middleware/rateLimit.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { forgotPasswordSchema, loginSchema, registerSchema, resetPasswordSchema } from "../validators/auth.validator.js";

export const authRouter = Router();

authRouter.post("/register", registerRateLimiter, validate(registerSchema), asyncHandler(AuthController.register));
authRouter.post("/login", loginRateLimiter, validate(loginSchema), asyncHandler(AuthController.login));
// Rate-limited like sign-in, so neither can be used to flood someone's inbox or guess links
authRouter.post("/forgot-password", loginRateLimiter, validate(forgotPasswordSchema), asyncHandler(AuthController.forgotPassword));
authRouter.post("/reset-password", loginRateLimiter, validate(resetPasswordSchema), asyncHandler(AuthController.resetPassword));
authRouter.get("/me", authenticate, asyncHandler(AuthController.me));
authRouter.post("/logout", authenticate, asyncHandler(AuthController.logout));
