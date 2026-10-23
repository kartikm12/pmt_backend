import type { SupabaseClient } from "@supabase/supabase-js";

// Every file in a bucket with its size and type (Supabase lists one folder at a time, 1000 entries per page)
export async function listAll(client: SupabaseClient, bucket: string, prefix = ""): Promise<Map<string, { size: number; type: string }>> {
  const out = new Map<string, { size: number; type: string }>();
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client.storage.from(bucket).list(prefix, { limit: 1000, offset, sortBy: { column: "name", order: "asc" } });
    if (error) throw new Error(`Listing ${bucket}/${prefix}: ${error.message}`);
    for (const o of data ?? []) {
      const path = prefix ? `${prefix}/${o.name}` : o.name;
      if (o.id) out.set(path, { size: Number(o.metadata?.size ?? 0), type: String(o.metadata?.mimetype ?? "application/octet-stream") });
      else for (const [p, v] of await listAll(client, bucket, path)) out.set(p, v);
    }
    if (!data || data.length < 1000) break;
  }
  return out;
}

export const bucketPairs = (raw: string | undefined, fallback: string) =>
  (raw ?? fallback).split(",").map((p) => p.trim()).filter(Boolean).map((p) => { const [a, b] = p.split(":"); return [a, b ?? a] as const; });
