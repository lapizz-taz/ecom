import "server-only";
import { COLUMNS, type RegistrationRecord } from "@/lib/registration";

/**
 * Instant email alert for each new registration, sent with Resend (resend.com,
 * free tier is plenty). Set RESEND_API_KEY and NOTIFY_EMAIL_TO. Optional:
 * NOTIFY_EMAIL_FROM (must be on a domain you verified in Resend).
 */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function emailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.NOTIFY_EMAIL_TO);
}

export function renderEmail(r: RegistrationRecord) {
  const rows = COLUMNS.filter(([k]) => r[k])
    .map(
      ([k, label]) =>
        `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee;color:#6b6b6b;white-space:nowrap;vertical-align:top">${esc(label)}</td>` +
        `<td style="padding:8px 12px;border-bottom:1px solid #eee;color:#1a1a1a">${esc(r[k]).replace(/\n/g, "<br>")}</td></tr>`,
    )
    .join("");
  const wa = r.whatsapp.replace(/\D/g, "");
  const html = `<div style="font-family:Inter,Arial,sans-serif;max-width:640px;margin:0 auto">
  <div style="background:#e02424;color:#fff;padding:20px 24px;border-radius:12px 12px 0 0">
    <div style="font-size:13px;opacity:.9">New registration · UniBee website</div>
    <div style="font-size:22px;font-weight:700;margin-top:4px">${esc(r.full_name)}</div>
    <div style="font-size:14px;margin-top:4px">${esc(r.study_level)} · ${esc(r.english_test)}${r.english_score ? " " + esc(r.english_score) : ""}</div>
  </div>
  <div style="border:1px solid #eee;border-top:0;border-radius:0 0 12px 12px;padding:16px 12px">
    <p style="margin:0 12px 12px"><a href="https://wa.me/${wa}" style="display:inline-block;background:#128c4b;color:#fff;text-decoration:none;padding:10px 16px;border-radius:999px;font-weight:600">Chat on WhatsApp</a></p>
    <table style="border-collapse:collapse;width:100%;font-size:14px">${rows}</table>
  </div></div>`;
  const text = COLUMNS.filter(([k]) => r[k]).map(([k, label]) => `${label}: ${r[k]}`).join("\n");
  return { subject: `New registration: ${r.full_name} (${r.study_level})`, html, text };
}

export async function sendNotification(r: RegistrationRecord) {
  if (!emailConfigured()) return { sent: false, reason: "not-configured" };
  const { subject, html, text } = renderEmail(r);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.NOTIFY_EMAIL_FROM || "UniBee Website <onboarding@resend.dev>",
      to: process.env.NOTIFY_EMAIL_TO!.split(",").map((s) => s.trim()).filter(Boolean),
      reply_to: r.email || undefined,
      subject,
      html,
      text,
    }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Resend failed: ${res.status} ${await res.text()}`);
  return { sent: true };
}
