// Copies the app's database (everything in the "public" schema: tables, enum types, rows) from one Postgres to
// another with Postgres' own tools (pg_dump / pg_restore 17, run in Docker so nothing needs installing).
//
//   SRC_DATABASE_URL=...  DST_DATABASE_URL=...  npx tsx src/scripts/region-move/copy-db.ts [--replace]
//
// Safe by default: it refuses to write into a target that already has app tables, unless --replace is given
// (used for the final copy just before switching). It never writes to the source. At the end it prints the
// row count of every table on both sides; verify.ts checks them properly.
import { execFileSync } from "child_process";

const SRC = process.env.SRC_DATABASE_URL;
const DST = process.env.DST_DATABASE_URL;
const replace = process.argv.includes("--replace");
const IMAGE = "postgres:17";
if (!SRC || !DST) throw new Error("Set SRC_DATABASE_URL and DST_DATABASE_URL");
if (SRC === DST) throw new Error("Source and target are the same database");

// A database on this computer is "localhost" for us but "host.docker.internal" inside the container
const forDocker = (url: string) => url.replace(/@(localhost|127\.0\.0\.1)([:/])/, "@host.docker.internal$2");
const hostOf = (url: string) => url.replace(/^.*@/, "").replace(/[/?].*$/, "");

// Runs a command inside the Postgres container; the two addresses go in as environment variables, never on
// a command line where they'd be visible in the process list
function pg(script: string, input?: string) {
  return execFileSync("docker", ["run", "--rm", "-i", "-e", "SRC", "-e", "DST", IMAGE, "sh", "-c", script], {
    env: { ...process.env, SRC: forDocker(SRC!), DST: forDocker(DST!) },
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024
  });
}

const TABLES_SQL = `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`;
const tables = (side: "SRC" | "DST") => pg(`psql "$${side}" -At -v ON_ERROR_STOP=1 -c "${TABLES_SQL}"`).split("\n").filter(Boolean);
const counts = (side: "SRC" | "DST", names: string[]) => {
  if (!names.length) return {};
  const sql = names.map((t) => `SELECT '${t}', count(*) FROM public."${t}"`).join(" UNION ALL ");
  return Object.fromEntries(pg(`psql "$${side}" -At -F '|' -v ON_ERROR_STOP=1 -f -`, sql + ";").split("\n").filter(Boolean).map((l) => { const [t, n] = l.split("|"); return [t, Number(n)]; }));
};

console.log(`Source: ${hostOf(SRC)}\nTarget: ${hostOf(DST)}`);
const srcTables = tables("SRC");
if (!srcTables.length) throw new Error("The source has no tables in the public schema: wrong address?");
const dstTables = tables("DST");
if (dstTables.length && !replace) {
  console.error(`The target already has ${dstTables.length} tables (${dstTables.slice(0, 5).join(", ")}…). Nothing was changed.\nRun again with --replace to overwrite them (the final copy before switching).`);
  process.exit(1);
}
if (dstTables.length) {
  console.log(`--replace: removing the target's ${dstTables.length} app tables and enum types first`);
  pg(`psql "$DST" -v ON_ERROR_STOP=1 -f -`, `DO $$ DECLARE r record; BEGIN
    FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE'; END LOOP;
    FOR r IN SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typtype = 'e' LOOP EXECUTE 'DROP TYPE IF EXISTS public.' || quote_ident(r.typname) || ' CASCADE'; END LOOP;
  END $$;`);
}

console.log("Copying (pg_dump | pg_restore)…");
const started = Date.now();
let log = "";
try {
  // --no-owner/--no-privileges: the new project has its own roles. Errors are collected, not fatal, so they can
  // be judged below (the target always has a "public" schema already, which pg_restore reports)
  log = pg(`pg_dump "$SRC" --schema=public --no-owner --no-privileges --format=custom | pg_restore --dbname="$DST" --no-owner --no-privileges 2>&1; echo "RESTORE_EXIT=$?"`);
} catch (e) {
  log = String((e as { stdout?: string }).stdout ?? "") + String((e as { stderr?: string }).stderr ?? e);
}
const errors = log.split("\n").filter((l) => /error:/i.test(l));
const harmless = (l: string) => /schema "public" already exists/.test(l) || /unrecognized configuration parameter "transaction_timeout"/.test(l);
const real = errors.filter((l) => !harmless(l));
if (real.length) {
  console.error(`The copy reported problems:\n${real.slice(0, 20).join("\n")}`);
  process.exit(1);
}
const after = tables("DST");
const a = counts("SRC", srcTables), b = counts("DST", after);
console.log(`\nDone in ${Math.round((Date.now() - started) / 1000)} s.\n${"table".padEnd(22)} ${"source".padStart(8)} ${"target".padStart(8)}`);
let mismatch = 0;
for (const t of srcTables) {
  const same = a[t] === b[t];
  if (!same) mismatch++;
  console.log(`${same ? " " : "!"} ${t.padEnd(20)} ${String(a[t]).padStart(8)} ${String(b[t] ?? "missing").padStart(8)}`);
}
if (mismatch) { console.error(`\n${mismatch} table(s) differ. Do not switch.`); process.exit(1); }
console.log("\nEvery table has the same number of rows on both sides.");
