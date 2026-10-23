// The last check before switching the app to the new region. Read-only on both sides. It passes only if:
//   - every table has the same number of rows in the old and new database
//   - every stored file exists in the new project with the same size, and the bucket privacy matches
//   - nothing in the new database still points at the old Supabase project
//   - the new project hands out a working signed link for a private file
//
//   SRC_DATABASE_URL DST_DATABASE_URL SRC_SUPABASE_URL SRC_SERVICE_ROLE_KEY DST_SUPABASE_URL DST_SERVICE_ROLE_KEY
//   [BUCKETS="pmt-files,uploads"]   npx tsx src/scripts/region-move/verify.ts
import { PrismaClient } from "@prisma/client";
import { createClient } from "@supabase/supabase-js";
import { bucketPairs, listAll } from "./storage-list.js";

const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`Set ${k}`); return v; };
const oldDb = new PrismaClient({ datasourceUrl: need("SRC_DATABASE_URL") });
const newDb = new PrismaClient({ datasourceUrl: need("DST_DATABASE_URL") });
const src = createClient(need("SRC_SUPABASE_URL"), need("SRC_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const dst = createClient(need("DST_SUPABASE_URL"), need("DST_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const pairs = bucketPairs(process.env.BUCKETS, "pmt-files,uploads");
const problems: string[] = [];
const ok = (msg: string) => console.log(`ok    ${msg}`);
const bad = (msg: string) => { problems.push(msg); console.log(`FAIL  ${msg}`); };

const tables = async (db: PrismaClient) =>
  (await db.$queryRawUnsafe<{ t: string }[]>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).map((r) => r.t);
const count = async (db: PrismaClient, t: string) => Number((await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${t}"`))[0].n);

console.log("Database");
const [ta, tb] = [await tables(oldDb), await tables(newDb)];
const missing = ta.filter((t) => !tb.includes(t));
if (missing.length) bad(`tables missing in the new database: ${missing.join(", ")}`);
for (const t of ta.filter((x) => tb.includes(x))) {
  const [a, b] = [await count(oldDb, t), await count(newDb, t)];
  a === b ? ok(`${t}: ${a} rows on both sides`) : bad(`${t}: ${a} rows in the old database, ${b} in the new`);
}

console.log("\nFiles");
for (const [from, to] of pairs) {
  const [ia, ib] = [await src.storage.getBucket(from), await dst.storage.getBucket(to)];
  if (ib.error || !ib.data) { bad(`bucket "${to}" doesn't exist in the new project`); continue; }
  ia.data?.public === ib.data.public ? ok(`bucket "${to}" is ${ib.data.public ? "public" : "private"}, like the old one`) : bad(`bucket "${to}" privacy differs from the old one`);
  const [fa, fb] = [await listAll(src, from), await listAll(dst, to)];
  const absent = [...fa].filter(([p, v]) => fb.get(p)?.size !== v.size).map(([p]) => p);
  absent.length ? bad(`${from} -> ${to}: ${absent.length} of ${fa.size} files missing or different (e.g. ${absent.slice(0, 3).join(", ")})`) : ok(`${from} -> ${to}: all ${fa.size} files present with the same size`);
}

console.log("\nLinks");
const oldHost = new URL(need("SRC_SUPABASE_URL")).host;
// A real move: nothing may mention the old project at all. A rehearsal inside one project: nothing may
// point at the old buckets
const oldBase = `${need("SRC_SUPABASE_URL").replace(/\/$/, "")}/storage/v1/object/public/`;
const stale = oldHost !== new URL(need("DST_SUPABASE_URL")).host ? [`%${oldHost}%`] : pairs.map(([from]) => `${oldBase}${from}/%`);
for (const [table, col] of [["User", "avatarUrl"], ["Attachment", "url"]]) {
  let n = 0;
  for (const pattern of stale) n += Number((await newDb.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${table}" WHERE "${col}" LIKE $1`, pattern))[0].n);
  n ? bad(`${table}.${col}: ${n} still point at the old project (run rewrite-links.ts --apply)`) : ok(`${table}.${col}: nothing points at the old project`);
}
const privateBucket = pairs.find(([, to]) => to.includes("files"))?.[1];
const sample = await newDb.$queryRawUnsafe<{ url: string }[]>(`SELECT url FROM "Attachment" WHERE url LIKE 'private:%' LIMIT 1`);
if (privateBucket && sample[0]) {
  const { data, error } = await dst.storage.from(privateBucket).createSignedUrl(sample[0].url.slice("private:".length), 60);
  const res = data?.signedUrl ? await fetch(data.signedUrl) : null;
  res?.ok ? ok(`a private file opens from the new project (${sample[0].url.slice(8, 40)}…)`) : bad(`a private file doesn't open from the new project: ${error?.message ?? res?.status}`);
}

await oldDb.$disconnect(); await newDb.$disconnect();
console.log(problems.length ? `\nNOT READY: ${problems.length} problem(s). Do not switch.` : "\nREADY: the new region has everything. Safe to switch.");
process.exit(problems.length ? 1 : 0);
