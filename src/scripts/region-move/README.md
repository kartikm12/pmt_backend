# Moving PMT to Singapore

Today the app runs in **Frankfurt (Render)** with the database and files in **London (Supabase)**. Every click
from India pays ~0.19 s just to reach Europe. Both must move together: a Singapore server talking to a London
database would be slower than today.

Target: **Render Singapore + Supabase Singapore (`ap-southeast-1`)**. Rehearsed end to end with
`rehearse-region-move.mjs` (23/23, throwaway copies only).

## 1. New Supabase project (you)
1. Supabase → New project → Region **Southeast Asia (Singapore)**. Note the database password.
2. Project Settings → Database → **Connection string → Session pooler (port 5432)**. That is `DATABASE_URL`
   (and `DIRECT_URL`); add `?sslmode=require` at the end.
3. Project Settings → API: the **Project URL** (`SUPABASE_URL`), **anon** key, **service_role** key.
4. Put them in `D:\downloads\pmt\.env.singapore` (this folder is not in git), one per line:
   ```
   DATABASE_URL=...
   SUPABASE_URL=...
   SUPABASE_ANON_KEY=...
   SUPABASE_SERVICE_ROLE_KEY=...
   ```
   Don't paste them into chat.

## 2. First copy (Claude, or anyone with both env files) — the live app keeps running
From `pmt_backend`, with the OLD values as `SRC_*` and the NEW ones as `DST_*`:
```
npx tsx src/scripts/region-move/copy-db.ts
npx tsx src/scripts/region-move/copy-storage.ts
npx tsx src/scripts/region-move/rewrite-links.ts --apply
npx tsx src/scripts/region-move/verify.ts
```
`verify.ts` must end with **READY**.

## 3. New Render service in Singapore (you)
Render → New → Web Service → same repo `kartikm12/pmt_backend`, branch `main`, **Region: Singapore**,
same build/start commands and plan as `pmt-backend-1`. Environment: copy every variable from `pmt-backend-1`,
then change only:
- `DATABASE_URL`, `DIRECT_URL` → the new Supabase pooler address
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` → the new project's
- keep **`JWT_SECRET` exactly the same** (people stay signed in, file links keep working)

Wait for it to show **Live**, then send Claude its address (`https://….onrender.com`).

## 4. Switch (about 10 minutes, pick a quiet time)
1. Tell the team: no changes for 10 minutes.
2. Final copy: `copy-db.ts --replace`, `copy-storage.ts`, `rewrite-links.ts --apply`, `verify.ts` → READY.
3. Vercel → project `pmt_frontend1.` → Settings → Environment Variables → `VITE_API_URL` = the Singapore
   address → Deployments → **Redeploy**.
4. Claude checks the live site (speed, sign-in, files).

## 5. Afterwards
Keep `pmt-backend-1` and the London project for a few days as a fallback (switching back = setting
`VITE_API_URL` back), then suspend/delete them.
