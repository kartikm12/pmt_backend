import type {
  AssetStatus,
  AssetCondition,
  AssetAssignmentReceiptStatus,
  AssetAssignmentCollectionStatus,
  AssetEventType
} from "@prisma/client";

export interface CreateAssetInput {
  categoryId: string;
  name: string;
  brand?: string;
  model?: string;
  serialNumber?: string;
  specifications?: string;
  condition: AssetCondition;
  location?: string;
  purchaseDate?: string;
  purchaseCost?: number;
  vendorName?: string;
  warrantyStartDate?: string;
  warrantyEndDate?: string;
  warrantyMonths?: number | null;
  assignmentType: "STOCK" | "ASSIGN";
  employeeId?: string;
  projectId?: string;
  assignmentCondition?: AssetCondition;
  notes?: string;
}

export interface UpdateAssetInput {
  name?: string;
  categoryId?: string;
  brand?: string;
  model?: string;
  serialNumber?: string;
  specifications?: string;
  condition?: AssetCondition;
  location?: string;
  purchaseDate?: string | null;
  purchaseCost?: number | null;
  vendorName?: string | null;
  warrantyStartDate?: string | null;
  warrantyEndDate?: string | null;
}

export interface AssignAssetInput {
  employeeId: string;
  projectId?: string;
  assignmentCondition?: AssetCondition;
  notes?: string;
}

export interface ReturnAssetInput {
  returnDate?: string;
  returnCondition: AssetCondition;
  returnRemarks?: string;
  returnDisposition: "STOCK" | "REPAIR";
}

export interface MarkRepairInput {
  problemDescription: string;
  remarks?: string;
}

export interface CompleteRepairInput {
  condition: AssetCondition;
  disposition: "STOCK" | "ASSIGN";
  employeeId?: string;
  projectId?: string;
  remarks?: string;
}

export interface ReportProblemInput {
  problemCategory?: "HARDWARE" | "SOFTWARE" | "PHYSICAL_DAMAGE" | "LOST_STOLEN" | "OTHER";
  description: string;
  photoUrl?: string;
}

export interface AssetFilterParams {
  search?: string;
  categoryId?: string;
  status?: string;
  holderId?: string;
  warrantyExpiry?: "expired" | "30_days" | "60_days" | "valid" | "all";
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
  includeDeleted?: boolean;
}

