// Profile photos (and any attachment from before files went private) are saved as full public addresses that
// contain the OLD Supabase project. After copying, this points them at the new project. Private attachments
// ("private:<path>") need nothing: they are looked up in whatever project the server is connected to.
//
//   DST_DATABASE_URL=...  SRC_SUPABASE_URL=...  DST_SUPABASE_URL=...  [BUCKETS="uploads" or "from:to,..."]
//   npx tsx src/scripts/region-move/rewrite-links.ts           (shows what would change)
//   npx tsx src/scripts/region-move/rewrite-links.ts --apply   (changes it)
import { PrismaClient } from "@prisma/client";
import { bucketPairs } from "./storage-list.js";

const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`Set ${k}`); return v; };
const db = new PrismaClient({ datasourceUrl: need("DST_DATABASE_URL") });
const apply = process.argv.includes("--apply");
const base = (url: string) => `${url.replace(/\/$/, "")}/storage/v1/object/public/`;
const pairs = bucketPairs(process.env.BUCKETS, "uploads,pmt-files");
const swaps = pairs.map(([from, to]) => [`${base(need("SRC_SUPABASE_URL"))}${from}/`, `${base(need("DST_SUPABASE_URL"))}${to}/`] as const);

// Every column that can hold a full storage address
const COLUMNS = [["User", "avatarUrl"], ["Attachment", "url"]] as const;
let total = 0;
for (const [table, col] of COLUMNS) {
  for (const [oldPrefix, newPrefix] of swaps) {
    const [{ n }] = await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${table}" WHERE "${col}" LIKE $1`, `${oldPrefix}%`);
    if (!n) continue;
    total += n;
    console.log(`${table}.${col}: ${n} address(es) ${oldPrefix} -> ${newPrefix}`);
    if (apply) await db.$executeRawUnsafe(`UPDATE "${table}" SET "${col}" = $2 || substr("${col}", length($1) + 1) WHERE "${col}" LIKE $1 || '%'`, oldPrefix, newPrefix);
  }
}
// Anything still pointing at the old project (another bucket, an odd address) is reported, never guessed at
const oldHost = new URL(need("SRC_SUPABASE_URL")).host;
for (const [table, col] of COLUMNS) {
  const left = await db.$queryRawUnsafe<{ v: string }[]>(`SELECT "${col}" AS v FROM "${table}" WHERE "${col}" LIKE $1 LIMIT 5`, `%${oldHost}%`);
  if (left.length && (apply || total === 0)) console.log(`still pointing at the old project in ${table}.${col}:`, left.map((r) => r.v));
}
console.log(total ? (apply ? `\nUpdated ${total} address(es).` : `\n${total} address(es) would change. Run with --apply to change them.`) : "\nNothing to change.");
await db.$disconnect();
