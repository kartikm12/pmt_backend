// Copies stored files from one Supabase project to another, bucket by bucket: attachments (private "pmt-files",
// thumbnails included) and profile photos (public "uploads"). Each target bucket is created with the same
// privacy as its source. Files already in the target with the same size are skipped, so it can be run again
// for the final copy and only picks up what's new. It never deletes or changes anything in the source.
//
//   SRC_SUPABASE_URL=... SRC_SERVICE_ROLE_KEY=... DST_SUPABASE_URL=... DST_SERVICE_ROLE_KEY=...
//   BUCKETS="pmt-files,uploads"   (or "from:to,from:to" to copy into differently named buckets)
//   npx tsx src/scripts/region-move/copy-storage.ts
import { createClient } from "@supabase/supabase-js";
import { bucketPairs, listAll } from "./storage-list.js";

const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`Set ${k}`); return v; };
const src = createClient(need("SRC_SUPABASE_URL"), need("SRC_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const dst = createClient(need("DST_SUPABASE_URL"), need("DST_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const pairs = bucketPairs(process.env.BUCKETS, "pmt-files,uploads");
if (process.env.SRC_SUPABASE_URL === process.env.DST_SUPABASE_URL && pairs.some(([a, b]) => a === b)) throw new Error("Same project and same bucket name on both sides");

let copied = 0, skipped = 0, failed = 0;
for (const [from, to] of pairs) {
  const { data: info, error } = await src.storage.getBucket(from);
  if (error || !info) throw new Error(`Source bucket "${from}" not found: ${error?.message}`);
  const existing = await dst.storage.getBucket(to);
  if (existing.error) {
    const made = await dst.storage.createBucket(to, { public: info.public, fileSizeLimit: info.file_size_limit ?? undefined, allowedMimeTypes: info.allowed_mime_types ?? undefined });
    if (made.error) throw new Error(`Creating target bucket "${to}": ${made.error.message}`);
    console.log(`Created bucket "${to}" (${info.public ? "public" : "private"}, same as the source)`);
  } else if (existing.data.public !== info.public) {
    throw new Error(`Target bucket "${to}" is ${existing.data.public ? "public" : "private"} but the source is ${info.public ? "public" : "private"}: fix it in Supabase first`);
  }
  const want = await listAll(src, from);
  const have = await listAll(dst, to);
  console.log(`\n${from} -> ${to}: ${want.size} files in the source, ${have.size} already in the target`);
  const todo = [...want].filter(([p, v]) => have.get(p)?.size !== v.size);
  skipped += want.size - todo.length;
  // A few at a time: quick, without hammering either project
  const queue = [...todo];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const [path, meta] = item;
      try {
        const { data, error: e1 } = await src.storage.from(from).download(path);
        if (e1 || !data) throw new Error(e1?.message ?? "no data");
        const { error: e2 } = await dst.storage.from(to).upload(path, data, { contentType: meta.type, upsert: true, cacheControl: "3600" });
        if (e2) throw new Error(e2.message);
        copied++;
      } catch (e) {
        failed++;
        console.error(`  could not copy ${from}/${path}: ${(e as Error).message}`);
      }
    }
  }));
}
console.log(`\nCopied ${copied}, already there ${skipped}, failed ${failed}.`);
if (failed) process.exit(1);
