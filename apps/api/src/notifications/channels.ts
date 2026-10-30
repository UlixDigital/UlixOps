// Email (SMTP) and Slack webhook delivery. Failures are logged; callers must not throw upward.
import nodemailer from "nodemailer";

export interface MailMessage {
  to: string[];
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export interface SlackPoster {
  post(text: string): Promise<void>;
}

/** Builds a nodemailer transport from SMTP_URL (smtp:// or smtps://). */
export function createSmtpMailer(smtpUrl: string, from: string): Mailer | null {
  let parsed: URL;
  try {
    parsed = new URL(smtpUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "smtp:" && parsed.protocol !== "smtps:") return null;
  if (!parsed.hostname) return null;

  const secure = parsed.protocol === "smtps:" || parsed.port === "465";
  const port = parsed.port ? Number(parsed.port) : secure ? 465 : 587;
  const transporter = nodemailer.createTransport({
    host: parsed.hostname,
    port,
    secure,
    auth:
      parsed.username || parsed.password
        ? {
            user: decodeURIComponent(parsed.username),
            pass: decodeURIComponent(parsed.password),
          }
        : undefined,
  });

  return {
    async send(message) {
      if (message.to.length === 0) return;
      await transporter.sendMail({
        from,
        to: message.to.join(", "),
        subject: message.subject,
        text: message.text,
      });
    },
  };
}

export function createSlackPoster(webhookUrl: string): SlackPoster | null {
  let parsed: URL;
  try {
    parsed = new URL(webhookUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;

  return {
    async post(text) {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: text.slice(0, 3000) }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`Slack webhook HTTP ${res.status}`);
    },
  };
}

export function defaultMailFrom(publicUrl: string): string {
  try {
    return `UlixOps <noreply@${new URL(publicUrl).hostname}>`;
  } catch {
    return "UlixOps <noreply@localhost>";
  }
}
