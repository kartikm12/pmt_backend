// Password hashing off the main thread.
// bcryptjs is plain JavaScript: one check at 10 rounds keeps the CPU busy for ~70-100 ms, and on the main thread
// that freezes EVERY other request meanwhile. A morning rush of 150 sign-ins then queues for ~15-18 s. Here the
// same bcryptjs runs in a few worker threads, so the API keeps answering and several checks run side by side.
// Hashes are the same $2b$ format as before: every saved password keeps working.
// If a worker can't start or dies, the check runs the old in-thread way: a sign-in never fails because of this.
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import os from "node:os";
import bcrypt from "bcryptjs";

const require = createRequire(import.meta.url);
const BCRYPT_PATH = require.resolve("bcryptjs");

// Plain CommonJS. execArgv: [] below keeps the parent's loader flags (tsx, --input-type) out of the worker,
// so this runs the same under tsx locally and from dist on Render.
const WORKER_CODE = `
const { parentPort, workerData } = require("node:worker_threads");
const bcrypt = require(workerData.bcryptPath);
parentPort.on("message", ({ id, op, a, b }) => {
  try {
    const result = op === "hash" ? bcrypt.hashSync(a, b) : bcrypt.compareSync(a, b);
    parentPort.postMessage({ id, result });
  } catch (e) {
    parentPort.postMessage({ id, error: String((e && e.message) || e) });
  }
});
parentPort.postMessage({ ready: true });
`;

type Op = "hash" | "compare";
type Job = { op: Op; a: string; b: string | number; resolve: (v: unknown) => void; reject: (e: Error) => void };
type Slot = { worker: Worker; jobs: Map<number, Job>; ready: boolean };

const SIZE = Math.max(1, Math.min(4, Number(process.env.PASSWORD_WORKERS) || os.availableParallelism()));
const slots: (Slot | null)[] = Array.from({ length: SIZE }, () => null);
let nextId = 1;
let workersBroken = false;

const inThread = (op: Op, a: string, b: string | number) =>
  op === "hash" ? bcrypt.hash(a, b as number) : bcrypt.compare(a, b as string);

function startSlot(index: number): Slot {
  const worker = new Worker(WORKER_CODE, { eval: true, execArgv: [], workerData: { bcryptPath: BCRYPT_PATH } });
  const slot: Slot = { worker, jobs: new Map(), ready: false };
  worker.unref(); // never keeps the process alive on shutdown
  worker.on("message", (msg: { ready?: boolean; id?: number; result?: unknown; error?: string }) => {
    if (msg.ready) {
      slot.ready = true;
      return;
    }
    const job = slot.jobs.get(msg.id!);
    if (!job) return;
    slot.jobs.delete(msg.id!);
    if (msg.error !== undefined) job.reject(new Error(msg.error));
    else job.resolve(msg.result);
  });
  let done = false;
  const fail = (why: unknown) => {
    if (done) return;
    done = true;
    if (!slot.ready) {
      workersBroken = true; // it never started: this host can't run workers, stay in-thread from now on
      console.warn("Password workers unavailable, checking passwords on the main thread:", why);
    }
    if (slots[index] === slot) slots[index] = null; // otherwise a fresh worker starts on the next call
    for (const job of slot.jobs.values()) inThread(job.op, job.a, job.b).then(job.resolve, job.reject);
    slot.jobs.clear();
  };
  worker.on("error", fail);
  worker.on("exit", (code) => fail(`exit ${code}`));
  return slot;
}

function run<T>(op: Op, a: string, b: string | number): Promise<T> {
  if (workersBroken) return inThread(op, a, b) as Promise<T>;
  let best = -1;
  for (let i = 0; i < SIZE; i++) {
    if (!slots[i]) {
      try {
        slots[i] = startSlot(i);
      } catch (err) {
        workersBroken = true;
        console.warn("Password workers unavailable, checking passwords on the main thread:", err);
        return inThread(op, a, b) as Promise<T>;
      }
    }
    if (best < 0 || slots[i]!.jobs.size < slots[best]!.jobs.size) best = i;
  }
  const slot = slots[best]!;
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    slot.jobs.set(id, { op, a, b, resolve: resolve as (v: unknown) => void, reject });
    slot.worker.postMessage({ id, op, a, b });
  });
}

export const hashPassword = (plain: string, rounds: number) => run<string>("hash", plain, rounds);
export const comparePassword = (plain: string, hash: string) => run<boolean>("compare", plain, hash);
