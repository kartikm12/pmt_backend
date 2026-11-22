import { z } from "zod";

const assetConditionEnum = z.enum(["NEW", "GOOD", "FAIR", "DAMAGED"]);

// A real calendar date: 2026-13-45 or 2026-02-30 used to get through and crash the save
const realDay = (v: string) => {
  const [y, m, d] = v.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};
const optionalDateString = z
  .string()
  .datetime({ offset: true })
  .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(realDay, "That date doesn't exist"))
  .or(z.literal(""))
  .optional()
  .nullable();

export const createAssetSchema = z
  .object({
    categoryId: z.string().min(1, "Category is required"),
    name: z.string().trim().min(1, "Asset name is required").max(100),
    brand: z.string().max(100).optional().nullable(),
    model: z.string().max(100).optional().nullable(),
    serialNumber: z.string().max(100).optional().nullable(),
    specifications: z.string().max(2000).optional().nullable(),
    condition: assetConditionEnum,
    location: z.string().max(100).optional().nullable(),
    purchaseDate: optionalDateString,
    purchaseCost: z.number().nonnegative("Purchase cost cannot be negative").optional().nullable(),
    vendorName: z.string().max(100).optional().nullable(),
    warrantyStartDate: optionalDateString,
    warrantyEndDate: optionalDateString,
    // Warranty as a length in months (the screens send this); the end date is worked out from it
    warrantyMonths: z.number().int().min(1, "Pick a warranty period").max(120, "Warranty can be at most 10 years").optional().nullable(),
    assignmentType: z.enum(["STOCK", "ASSIGN"]),
    employeeId: z.string().optional().nullable(),
    projectId: z.string().optional().nullable(),
    assignmentCondition: assetConditionEnum.optional().nullable(),
    notes: z.string().max(1000).optional().nullable()
  })
  .refine(
    (data) => {
      if (data.assignmentType === "ASSIGN" && !data.employeeId) {
        return false;
      }
      return true;
    },
    {
      message: "Employee selection is required when assigning asset",
      path: ["employeeId"]
    }
  )
  .refine(
    (data) => {
      if (data.warrantyStartDate && data.warrantyEndDate) {
        return new Date(data.warrantyEndDate) >= new Date(data.warrantyStartDate);
      }
      return true;
    },
    {
      message: "Warranty end date cannot be earlier than warranty start date",
      path: ["warrantyEndDate"]
    }
  );

export const updateAssetSchema = z
  .object({
    name: z.string().trim().min(1, "Asset name is required").max(100).optional(),
    categoryId: z.string().min(1).optional(),
    brand: z.string().max(100).optional().nullable(),
    model: z.string().max(100).optional().nullable(),
    serialNumber: z.string().max(100).optional().nullable(),
    specifications: z.string().max(2000).optional().nullable(),
    condition: assetConditionEnum.optional(),
    location: z.string().max(100).optional().nullable(),
    purchaseDate: optionalDateString,
    purchaseCost: z.number().nonnegative("Purchase cost cannot be negative").optional().nullable(),
    vendorName: z.string().max(100).optional().nullable(),
    warrantyStartDate: optionalDateString,
    warrantyEndDate: optionalDateString
  })
  .refine(
    (data) => {
      if (data.warrantyStartDate && data.warrantyEndDate) {
        return new Date(data.warrantyEndDate) >= new Date(data.warrantyStartDate);
      }
      return true;
    },
    {
      message: "Warranty end date cannot be earlier than warranty start date",
      path: ["warrantyEndDate"]
    }
  );

export const assignAssetSchema = z.object({
  employeeId: z.string().min(1, "Employee is required"),
  projectId: z.string().optional().nullable(),
  assignmentCondition: assetConditionEnum.optional().nullable(),
  notes: z.string().max(1000).optional().nullable()
});

export const returnAssetSchema = z.object({
  returnDate: optionalDateString,
  returnCondition: assetConditionEnum,
  returnRemarks: z.string().max(1000).optional().nullable(),
  returnDisposition: z.enum(["STOCK", "REPAIR"])
});

export const markRepairSchema = z.object({
  problemDescription: z.string().min(1, "Problem description is required").max(2000),
  remarks: z.string().max(1000).optional().nullable()
});

export const completeRepairSchema = z
  .object({
    condition: assetConditionEnum,
    disposition: z.enum(["STOCK", "ASSIGN"]),
    employeeId: z.string().optional().nullable(),
    projectId: z.string().optional().nullable(),
    remarks: z.string().max(1000).optional().nullable()
  })
  .refine(
    (data) => {
      if (data.disposition === "ASSIGN" && !data.employeeId) {
        return false;
      }
      return true;
    },
    {
      message: "Employee selection is required when reassigning asset",
      path: ["employeeId"]
    }
  );

export const reportProblemSchema = z.object({
  problemCategory: z.enum(["HARDWARE", "SOFTWARE", "PHYSICAL_DAMAGE", "LOST_STOLEN", "OTHER"]).optional(),
  description: z.string().trim().min(1, "Write what the problem is.").max(2000),
  photoUrl: z.string().optional().nullable()
});

export const createCategorySchema = z.object({
  name: z.string().trim().min(1, "Category name is required").max(50),
  // Letters and digits only: the code goes into every tag (ENT-CODE-0001), so no spaces or dashes
  code: z.string().trim().toUpperCase().pipe(z.string().regex(/^[A-Z0-9]{2,10}$/, "Use 2 to 10 letters or digits for the code")),
  description: z.string().max(200).optional().nullable()
});


