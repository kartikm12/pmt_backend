import { PrismaClient } from "@prisma/client";
import { supabase } from "../utils/supabase.js";
import { FILES_BUCKET } from "../services/storage.service.js";

// Moves attachments uploaded before files went private (public "uploads" bucket) into the private bucket,
// then deletes the public copy, so old public links stop working. Profile photos are not touched.
// Dry run by default:  npm run migrate-files        Do it:  npm run migrate-files -- --apply
const prisma = new PrismaClient();
const PUBLIC_MARK = "/storage/v1/object/public/uploads/";

async function main() {
  const apply = process.argv.includes("--apply");
  const rows = await prisma.attachment.findMany({ where: { url: { contains: PUBLIC_MARK } }, select: { id: true, url: true, fileType: true } });
  console.log(`${rows.length} attachment(s) still in the public bucket.${apply ? "" : " Dry run: nothing changes (add --apply)."}`);
  let moved = 0;
  for (const r of rows) {
    const filePath = decodeURIComponent(r.url.slice(r.url.indexOf(PUBLIC_MARK) + PUBLIC_MARK.length).split("?")[0]);
    if (!apply) { console.log(`  would move ${filePath}`); continue; }
    const { data: blob, error: dl } = await supabase.storage.from("uploads").download(filePath);
    if (dl || !blob) { console.error(`  skip ${r.id}: couldn't download ${filePath}: ${dl?.message ?? "empty"}`); continue; }
    const { error: up } = await supabase.storage.from(FILES_BUCKET).upload(filePath, Buffer.from(await blob.arrayBuffer()), { contentType: r.fileType, upsert: true });
    if (up) { console.error(`  skip ${r.id}: couldn't upload to ${FILES_BUCKET}: ${up.message}`); continue; }
    // Point the row at the private copy first; only then remove the public one (a failure leaves a spare copy, never a dead link)
    await prisma.attachment.update({ where: { id: r.id }, data: { url: `private:${filePath}` } });
    const { error: rm } = await supabase.storage.from("uploads").remove([filePath]);
    if (rm) console.error(`  moved ${r.id}, but the public copy is still there: ${rm.message}`);
    moved++;
  }
  if (apply) console.log(`Moved ${moved} of ${rows.length}.`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
