import crypto from "crypto";
import { env } from "../config/env.js";

// Files are never handed out as storage URLs. The app gives a link to its own server, signed with the
// server secret and valid until the end of the next full hour (so 1-2 h), then GET /attachments/:id/file
// checks it and redirects to a 60-second storage link. A link copied out of the app dies within 2 hours,
// and only people who can still list the files get fresh ones.
const HOUR = 3600;
const sign = (id: string, exp: number) => crypto.createHmac("sha256", env.JWT_SECRET).update(`file:${id}:${exp}`).digest("base64url");

export function fileLink(id: string, now = Date.now()) {
  const exp = (Math.floor(now / 1000 / HOUR) + 2) * HOUR;
  return `/api/attachments/${encodeURIComponent(id)}/file?exp=${exp}&sig=${sign(id, exp)}`;
}

export function checkFileLink(id: string, exp: unknown, sig: unknown, now = Date.now()): "ok" | "expired" | "bad" {
  const e = Number(exp);
  if (!Number.isInteger(e) || typeof sig !== "string") return "bad";
  const want = Buffer.from(sign(id, e));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return "bad";
  return e * 1000 > now ? "ok" : "expired";
}

export const withFileLink = <T extends { id: string; url: string }>(a: T): T => ({ ...a, url: fileLink(a.id) });
