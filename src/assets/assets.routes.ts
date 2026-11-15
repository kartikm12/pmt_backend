import { Router } from "express";
import { AssetController } from "./assets.controller.js";
import { authenticate } from "../middleware/authenticate.js";
import { authorize } from "../middleware/authorize.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { USER_ROLE } from "../constants/enums.js";
import multer from "multer";
import { ApiError } from "../utils/apiError.js";
import {
  createAssetSchema,
  updateAssetSchema,
  assignAssetSchema,
  returnAssetSchema,
  markRepairSchema,
  completeRepairSchema,
  reportProblemSchema,
  createCategorySchema
} from "./assets.validator.js";

// Multer storage for photo uploads (images only, max 10MB)
const photoStorage = multer.memoryStorage();
const photoUpload = multer({
  storage: photoStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/png", "image/jpeg", "image/webp"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new ApiError(400, "Only image files (PNG, JPEG, WebP) are permitted for asset photographs. Invoices cannot be uploaded."));
    }
  }
});

export const assetRouter = Router();

// All asset routes require authentication
assetRouter.use(authenticate);

// 1. My Assets (Available to all authenticated employees)
assetRouter.get("/my-assets", asyncHandler(AssetController.myAssets));

// 2. Team Assets (Available to Managers and Admins)
assetRouter.get(
  "/team-assets",
  authorize(USER_ROLE.MANAGER, USER_ROLE.PROJECT_MANAGER, USER_ROLE.ADMIN),
  asyncHandler(AssetController.teamAssets)
);

// 3. Asset Notifications (Available to all employees)
assetRouter.get("/notifications", asyncHandler(AssetController.notifications));

// 4. Asset Categories
assetRouter.get("/categories", asyncHandler(AssetController.getCategories));
assetRouter.post(
  "/categories",
  authorize(USER_ROLE.ADMIN),
  validate(createCategorySchema),
  asyncHandler(AssetController.createCategory)
);

// 5. Recently Deleted (Admin only)
assetRouter.get(
  "/recently-deleted",
  authorize(USER_ROLE.ADMIN),
  asyncHandler(AssetController.recentlyDeleted)
);

// 6. Asset Register listing (Admin & Managers)
assetRouter.get(
  "/",
  authorize(USER_ROLE.MANAGER, USER_ROLE.PROJECT_MANAGER, USER_ROLE.ADMIN),
  asyncHandler(AssetController.list)
);

// 7. Create Asset (Admin & Managers)
assetRouter.post(
  "/",
  authorize(USER_ROLE.MANAGER, USER_ROLE.PROJECT_MANAGER, USER_ROLE.ADMIN),
  validate(createAssetSchema),
  asyncHandler(AssetController.create)
);

// 8. Single Asset details & sub-resources
assetRouter.get("/:id", asyncHandler(AssetController.getById));
assetRouter.get("/:id/history", asyncHandler(AssetController.history));

assetRouter.patch(
  "/:id",
  authorize(USER_ROLE.MANAGER, USER_ROLE.PROJECT_MANAGER, USER_ROLE.ADMIN),
  validate(updateAssetSchema),
  asyncHandler(AssetController.update)
);

// Soft delete & restore (Admin only)
assetRouter.delete(
  "/:id",
  authorize(USER_ROLE.ADMIN),
  asyncHandler(AssetController.remove)
);

assetRouter.post(
  "/:id/restore",
  authorize(USER_ROLE.ADMIN),
  asyncHandler(AssetController.restore)
);

// 9. Workflows: Assign, Confirm Receipt, Return
assetRouter.post(
  "/:id/assign",
  authorize(USER_ROLE.MANAGER, USER_ROLE.PROJECT_MANAGER, USER_ROLE.ADMIN),
  validate(assignAssetSchema),
  asyncHandler(AssetController.assign)
);

assetRouter.post(
  "/:id/confirm-receipt",
  asyncHandler(AssetController.confirmReceipt)
);

assetRouter.post(
  "/:id/return",
  authorize(USER_ROLE.MANAGER, USER_ROLE.PROJECT_MANAGER, USER_ROLE.ADMIN),
  validate(returnAssetSchema),
  asyncHandler(AssetController.returnAsset)
);

// 10. Repair Management
assetRouter.post(
  "/:id/repair",
  authorize(USER_ROLE.MANAGER, USER_ROLE.PROJECT_MANAGER, USER_ROLE.ADMIN),
  validate(markRepairSchema),
  asyncHandler(AssetController.markRepair)
);

assetRouter.post(
  "/:id/complete-repair",
  authorize(USER_ROLE.MANAGER, USER_ROLE.PROJECT_MANAGER, USER_ROLE.ADMIN),
  validate(completeRepairSchema),
  asyncHandler(AssetController.completeRepair)
);

// 11. Lost & Retire
assetRouter.post(
  "/:id/lost",
  authorize(USER_ROLE.MANAGER, USER_ROLE.PROJECT_MANAGER, USER_ROLE.ADMIN),
  asyncHandler(AssetController.markLost)
);

assetRouter.post(
  "/:id/retire",
  authorize(USER_ROLE.ADMIN),
  asyncHandler(AssetController.retire)
);

// 12. Employee Problem Report
assetRouter.post(
  "/:id/report-problem",
  validate(reportProblemSchema),
  asyncHandler(AssetController.reportProblem)
);

// 13. File Management (Photos)
assetRouter.post(
  "/:id/photos",
  // Managers, and the person holding it (a photo with "Report a problem"); the service checks which
  photoUpload.single("photo"),
  asyncHandler(AssetController.uploadPhoto)
);

assetRouter.delete(
  "/:id/photos/:fileId",
  authorize(USER_ROLE.MANAGER, USER_ROLE.PROJECT_MANAGER, USER_ROLE.ADMIN),
  asyncHandler(AssetController.deletePhoto)
);

