import fs from "fs";
import path from "path";
import { env } from "../config/env.js";
import { prisma } from "../prisma/client.js";
import { layout } from "./templates.js";

// Outgoing email over HTTPS APIs (port 443 works on every host; Render's free plan blocks SMTP ports).
// BREVO_API_KEY set -> Brevo; else RESEND_API_KEY -> Resend. With neither, nothing leaves the machine:
// each email is appended to mail-outbox.jsonl instead, which is what local runs and the test suites read.
export type Mail = { to: string; subject: string; heading: string; body: string; button?: { label: string; url: string } };

const OUTBOX = path.resolve(process.cwd(), "mail-outbox.jsonl");
// Logs show who an email went to without collecting full addresses: s***@gmail.com
const mask = (email: string) => email.replace(/^(.)[^@]*(@.*)$/, "$1***$2");

// "PMT <x@y.com>" -> { name: "PMT", email: "x@y.com" }; a bare address keeps the app name
export function parseFrom(from: string) {
  const m = from.trim().match(/^(.*?)\s*<([^>]+)>$/);
  return m ? { name: m[1].replace(/^"|"$/g, "").trim() || "PMT", email: m[2].trim() } : { name: "PMT", email: from.trim() };
}

type Provider = { name: "Brevo" | "Resend"; deliver: (to: string, subject: string, html: string, text: string) => Promise<Response>; idOf: (body: any) => string | undefined };

function provider(): Provider | null {
  if (env.BREVO_API_KEY) {
    const sender = parseFrom(env.MAIL_FROM);
    return {
      name: "Brevo",
      // Replies reach the real inbox even when Brevo rewrites a free-mail (gmail) sender address
      deliver: (to, subject, html, text) => fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": env.BREVO_API_KEY!, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ sender, replyTo: { email: sender.email }, to: [{ email: to }], subject, htmlContent: html, textContent: text }),
        signal: AbortSignal.timeout(10000)
      }),
      idOf: (b) => b?.messageId
    };
  }
  if (env.RESEND_API_KEY) {
    return {
      name: "Resend",
      deliver: (to, subject, html, text) => fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, html, text }),
        signal: AbortSignal.timeout(10000)
      }),
      idOf: (b) => b?.id
    };
  }
  return null;
}

export class MailService {
  // One line at startup, so the hosting log always says whether email can go out
  static logStatus() {
    const p = provider();
    if (!p) {
      console.warn(env.NODE_ENV === "production"
        ? "Email: OFF - neither BREVO_API_KEY nor RESEND_API_KEY is set, so no email will be sent."
        : `Email: local mode - emails are written to ${OUTBOX}, nothing is sent.`);
      return;
    }
    console.log(`Email: ON - sending through ${p.name} as "${env.MAIL_FROM}", links open ${this.appUrl()}`);
    if (p.name === "Resend" && /@resend\.dev>?$/i.test(env.MAIL_FROM.trim())) {
      console.warn("Email: test sender (resend.dev) - Resend only delivers to the email of the Resend account owner. Verify a domain and change MAIL_FROM to email everyone.");
    }
  }

  static appUrl(pathname = "") {
    return `${(env.APP_URL ?? env.CLIENT_URL).replace(/\/+$/, "")}${pathname}`;
  }

  // Never throws: an email problem must not break the action that triggered it
  static async send(mail: Mail): Promise<boolean> {
    const html = layout(mail.heading, mail.body, mail.button);
    const text = `${mail.heading}\n\n${mail.body}${mail.button ? `\n\n${mail.button.label}: ${mail.button.url}` : ""}`;
    const p = provider();
    if (!p) {
      // On the live server a file nobody reads would hide the problem, so say it in the log instead
      if (env.NODE_ENV === "production") {
        console.warn(`Email not sent (no BREVO_API_KEY or RESEND_API_KEY): "${mail.subject}" to ${mask(mail.to)}`);
        return false;
      }
      try {
        fs.appendFileSync(OUTBOX, JSON.stringify({ at: new Date().toISOString(), to: mail.to, subject: mail.subject, text, url: mail.button?.url }) + "\n");
      } catch (err) {
        console.warn("Mail outbox write failed:", (err as Error).message);
      }
      return true;
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await p.deliver(mail.to, mail.subject, html, text);
        if (res.ok) {
          const id = p.idOf(await res.json().catch(() => ({})));
          console.log(`Email sent: "${mail.subject}" to ${mask(mail.to)}${id ? ` (${p.name} id ${id})` : ""}`);
          return true;
        }
        const detail = (await res.text()).slice(0, 300);
        // 4xx = our request is wrong (bad key, unverified sender, blocked IP): retrying won't help
        console.error(`Email to ${mask(mail.to)} refused by ${p.name} (${res.status}): ${detail}`);
        if (res.status < 500) return false;
      } catch (err) {
        console.error(`Email to ${mask(mail.to)} failed (attempt ${attempt}):`, (err as Error).message);
      }
    }
    return false;
  }

  // Background send for notification emails: respects the person's "email me" setting and skips
  // accounts that can't use the app (suspended, removed, still waiting for approval)
  static notify(userId: string, mail: Omit<Mail, "to">) {
    void (async () => {
      const user = await prisma.user.findFirst({
        where: { id: userId, deletedAt: null, pendingApproval: false, status: { not: "SUSPENDED" }, emailNotifications: true },
        select: { email: true }
      });
      if (user) await this.send({ ...mail, to: user.email });
    })().catch((err) => console.error("Notification email failed:", err));
  }
}
