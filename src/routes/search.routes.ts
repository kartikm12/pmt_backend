import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { SearchService } from "../services/search.service.js";

export const searchRouter = Router();

searchRouter.use(authenticate);
searchRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.slice(0, 100) : "";
    res.status(200).json(await SearchService.search(q, req.user!.userId, req.user!.role));
  })
);
