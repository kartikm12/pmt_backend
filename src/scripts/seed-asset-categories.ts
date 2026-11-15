import { prisma } from "../prisma/client.js";

export const DEFAULT_ASSET_CATEGORIES = [
  { name: "Laptop", code: "LAP", description: "Laptops and notebooks" },
  { name: "Desktop", code: "DESK", description: "Desktop workstations and towers" },
  { name: "Monitor", code: "MON", description: "Display monitors and screens" },
  { name: "Mobile Phone", code: "PHN", description: "Company smartphones and phones" },
  { name: "Tablet", code: "TAB", description: "iPads and Android tablets" },
  { name: "Keyboard", code: "KEYB", description: "Keyboards" },
  { name: "Mouse", code: "MOU", description: "Mice and pointing devices" },
  { name: "Headset", code: "HEAD", description: "Audio headsets, headphones and earphones" },
  { name: "Accessories", code: "ACC", description: "Adapters, cables, docks and accessories" },
  { name: "Access Card", code: "CARD", description: "Office access cards and NFC badges" },
  { name: "Software Licence", code: "LIC", description: "Software licences and subscriptions" },
  { name: "Other", code: "OTH", description: "Other company assets" }
];

export async function seedAssetCategories() {
  console.log("Seeding default asset categories...");
  for (const cat of DEFAULT_ASSET_CATEGORIES) {
    await prisma.assetCategory.upsert({
      where: { code: cat.code },
      update: { name: cat.name, description: cat.description },
      create: {
        name: cat.name,
        code: cat.code,
        description: cat.description,
        isCustom: false
      }
    });
  }
  console.log("Asset categories seeded successfully!");
}

if (process.argv[1]?.endsWith("seed-asset-categories.ts")) {
  seedAssetCategories()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Seeding failed:", err);
      process.exit(1);
    });
}

