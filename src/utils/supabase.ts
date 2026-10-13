import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || '';
// Server-side only: the service role key can delete files; the public anon key can usually only upload,
// so with it alone deleted attachments and replaced avatars stay publicly downloadable
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing SUPABASE_URL or a Supabase key (SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY)");
} else if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("SUPABASE_SERVICE_ROLE_KEY is not set: deleted files may remain in storage");
}

export const supabase = createClient(supabaseUrl, supabaseKey);
