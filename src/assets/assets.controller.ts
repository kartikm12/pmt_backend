import type { Request, Response } from "express";
import { AssetService } from "./assets.service.js";
import { ApiError } from "../utils/apiError.js";

export class AssetController {
  static async list(req: Request, res: Response) {
    const user = { id: req.user!.userId, role: req.user!.role };
    // Whatever arrives in the address is cleaned here: an unknown sort field, status or page used to
    // crash the list, and any page size was honoured (100,000 at once)
    const q = (k: string) => (typeof req.query[k] === "string" ? (req.query[k] as string) : undefined);
    const whole = (v: string | undefined, fallback: number, min: number, max: number) => {
      const n = Number.parseInt(v ?? "", 10);
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    };
    const SORTABLE = ["createdAt", "updatedAt", "assetTag", "name", "status", "warrantyEndDate", "purchaseDate"];
    const STATUSES = ["IN_STOCK", "ASSIGNED", "IN_REPAIR", "LOST", "RETIRED"];
    const status = q("status");
    const filters = {
      search: q("search")?.slice(0, 100),
      categoryId: q("categoryId"),
      status: status && STATUSES.includes(status) ? status : undefined,
      holderId: q("holderId"),
      warrantyExpiry: q("warrantyExpiry") as any,
      page: whole(q("page"), 1, 1, 100000),
      limit: whole(q("limit"), 20, 1, 100),
      sortBy: SORTABLE.includes(q("sortBy") ?? "") ? (q("sortBy") as string) : "createdAt",
      sortOrder: (q("sortOrder") === "asc" ? "asc" : "desc") as "asc" | "desc",
      includeDeleted: q("includeDeleted") === "true"
    };
    if (status && !filters.status) throw new ApiError(400, "Unknown status. Use IN_STOCK, ASSIGNED, IN_REPAIR, LOST or RETIRED.");

    const data = await AssetService.listAssets(user, filters);
    res.json(data);
  }

  static async getById(req: Request, res: Response) {
    const user = { id: req.user!.userId, role: req.user!.role };
    const asset = await AssetService.getAssetById(req.params.id, user);
    res.json(asset);
  }

  static async create(req: Request, res: Response) {
    const user = { id: req.user!.userId, role: req.user!.role };
    const asset = await AssetService.createAsset(user, req.body);
    res.status(201).json(asset);
  }

  static async update(req: Request, res: Response) {
    const user = { id: req.user!.userId, role: req.user!.role };
    const asset = await AssetService.updateAsset(req.params.id, user, req.body);
    res.json(asset);
  }

  static async remove(req: Request, res: Response) {
    const user = { id: req.user!.userId, role: req.user!.role };
    const result = await AssetService.softDeleteAsset(req.params.id, user);
    res.json(result);
  }

  static async restore(req: Request, res: Response) {
    const user = { id: req.user!.userId, role: req.user!.role };
    const asset = await AssetService.restoreAsset(req.params.id, user);
    res.json(asset);
  }

  static async assign(req: Request, res: Response) {
    const user = { id: req.user!.userId, role: req.user!.role };
    const asset = await AssetService.assignAsset(req.params.id, user, req.body);
    res.json(asset);
  }

  static async confirmReceipt(req: Request, res: Response) {
    const user = { id: req.user!.userId, role: req.user!.role };
    const asset = await AssetService.confirmReceipt(req.params.id, user);
    res.json(asset);
  }

  static async returnAsset(req: Request, res: Response) {
    const user = { id: req.user!.userId, role: req.user!.role };
    const asset = await AssetService.returnAsset(req.params.id, user, req.body);
    res.json(asset);
  }

  static async markRepair(req: Request, res: Response) {
    const user = { id: req.user!.userId, role: req.user!.role };
    const asset = await AssetService.markForRepair(req.params.id, user, req.body);
    res.json(asset);
  }

  static async completeRepair(req: Request, res: Response) {
    const user = { id: req.user!.userId, role: req.user!.role };
    const asset = await AssetService.completeRepair(req.params.id, user, req.body);
    res.json(asset);
  }

  static async markLost(req: Request, res: Response) {
    const user = { id: req.user!.userId, role: req.user!.role };
    const asset = await AssetService.markLost(req.params.id, user, req.body.remarks);
    res.json(asset);
  }

  static async retire(req: Request, res: Response) {
    const user = { id: req.user!.userId, role: req.user!.role };
    const asset = await AssetService.retireAsset(req.params.id, user, req.body.remarks);
    res.json(asset);
  }

  static async reportProblem(req: Request, res: Response) {
    const user = { id: req.user!.userId, role: req.user!.role };
    const result = await AssetService.reportProblem(req.params.id, user, req.body);
    res.json(result);
  }

  static async myAssets(req: Request, res: Response) {
    const items = await AssetService.getMyAssets(req.user!.userId);
    res.json(items);
  }

  static async teamAssets(req: Request, res: Response) {
    const data = await AssetService.getTeamAssets(req.user!.userId, req.user!.role);
    res.json(data);
  }

  static async recentlyDeleted(req: Request, res: Response) {
    const user = { id: req.user!.userId, role: req.user!.role };
    const items = await AssetService.getRecentlyDeleted(user);
    res.json(items);
  }

  static async history(req: Request, res: Response) {
    const user = { id: req.user!.userId, role: req.user!.role };
    const events = await AssetService.getAssetHistory(req.params.id, user);
    res.json(events);
  }

  static async uploadPhoto(req: Request, res: Response) {
    if (!req.file) {
      throw new ApiError(400, "Photograph file is required");
    }
    const user = { id: req.user!.userId, role: req.user!.role };
    const file = await AssetService.uploadPhoto(req.params.id, user, req.file);
    res.status(201).json(file);
  }

  static async deletePhoto(req: Request, res: Response) {
    const user = { id: req.user!.userId, role: req.user!.role };
    const result = await AssetService.deletePhoto(req.params.fileId, user);
    res.json(result);
  }

  static async getCategories(_req: Request, res: Response) {
    const categories = await AssetService.getCategories();
    res.json(categories);
  }

  static async createCategory(req: Request, res: Response) {
    const user = { id: req.user!.userId, role: req.user!.role };
    const category = await AssetService.createCategory(user, req.body);
    res.status(201).json(category);
  }

  static async notifications(req: Request, res: Response) {
    const notifications = await AssetService.getAssetNotifications(req.user!.userId);
    res.json(notifications);
  }
}
