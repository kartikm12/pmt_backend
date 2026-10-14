import { supabase } from "../utils/supabase.js";
import { FILES_BUCKET } from "../services/storage.service.js";

// One-time (safe to re-run): make sure the private bucket for attachments exists and is private.
// Needs SUPABASE_SERVICE_ROLE_KEY.  npm run setup-storage
async function main() {
  const { data: buckets, error } = await supabase.storage.listBuckets();
  if (error) throw new Error(`Couldn't list buckets: ${error.message} (is SUPABASE_SERVICE_ROLE_KEY set?)`);
  const found = buckets.find((b) => b.name === FILES_BUCKET);
  if (!found) {
    const { error: e } = await supabase.storage.createBucket(FILES_BUCKET, { public: false, fileSizeLimit: "25MB" });
    if (e) throw new Error(`Couldn't create ${FILES_BUCKET}: ${e.message}`);
    console.log(`Created private bucket "${FILES_BUCKET}".`);
  } else if (found.public) {
    const { error: e } = await supabase.storage.updateBucket(FILES_BUCKET, { public: false });
    if (e) throw new Error(`Couldn't make ${FILES_BUCKET} private: ${e.message}`);
    console.log(`Bucket "${FILES_BUCKET}" was public; it is private now.`);
  } else {
    console.log(`Bucket "${FILES_BUCKET}" already exists and is private. Nothing changed.`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
