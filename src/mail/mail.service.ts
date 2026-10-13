import fs from "fs";
import path from "path";
import { env } from "../config/env.js";
import { prisma } from "../prisma/client.js";
import { layout } from "./templates.js";

// Outgoing email. Sends through Resend's HTTPS API (port 443 works on every host; SMTP ports are often blocked).
// Without RESEND_API_KEY nothing leaves the machine: each email is appended to mail-outbox.jsonl instead,
// which is what local runs and the test suites read.
export type Mail = { to: string; subject: string; heading: string; body: string; button?: { label: string; url: string } };

const OUTBOX = path.resolve(process.cwd(), "mail-outbox.jsonl");
// Logs show who an email went to without collecting full addresses: s***@gmail.com
const mask = (email: string) => email.replace(/^(.)[^@]*(@.*)$/, "$1***$2");

export class MailService {
  // One line at startup, so the hosting log always says whether email can go out
  static logStatus() {
    if (!env.RESEND_API_KEY) {
      console.warn(env.NODE_ENV === "production"
        ? "Email: OFF - RESEND_API_KEY is not set, so no email will be sent."
        : `Email: local mode - emails are written to ${OUTBOX}, nothing is sent.`);
      return;
    }
    console.log(`Email: ON - sending through Resend as "${env.MAIL_FROM}", links open ${this.appUrl()}`);
    if (/@resend\.dev>?$/i.test(env.MAIL_FROM.trim())) {
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
    if (!env.RESEND_API_KEY) {
      // On the live server a file nobody reads would hide the problem, so say it in the log instead
      if (env.NODE_ENV === "production") {
        console.warn(`Email not sent (RESEND_API_KEY missing): "${mail.subject}" to ${mask(mail.to)}`);
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
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: env.MAIL_FROM, to: [mail.to], subject: mail.subject, html, text }),
          signal: AbortSignal.timeout(10000)
        });
        if (res.ok) {
          const { id } = (await res.json().catch(() => ({}))) as { id?: string };
          console.log(`Email sent: "${mail.subject}" to ${mask(mail.to)}${id ? ` (Resend id ${id})` : ""}`);
          return true;
        }
        const detail = (await res.text()).slice(0, 300);
        // 4xx = our request is wrong (bad key, unverified domain, test-mode recipient): retrying won't help
        console.error(`Email to ${mask(mail.to)} refused by Resend (${res.status}): ${detail}`);
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
