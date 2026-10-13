// One simple, mail-client-safe layout (tables + inline styles) for every email the app sends
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function layout(heading: string, body: string, button?: { label: string; url: string }) {
  const paragraphs = body.split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px;line-height:1.6;color:#334155;font-size:15px">${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
  const cta = button
    ? `<p style="margin:22px 0 6px"><a href="${esc(button.url)}" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:12px 22px;border-radius:10px">${esc(button.label)}</a></p>
       <p style="margin:0;color:#94a3b8;font-size:12px">Or open: ${esc(button.url)}</p>`
    : "";
  return `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:28px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:14px;padding:28px">
<tr><td>
<p style="margin:0 0 18px;font-weight:bold;color:#0f172a;font-size:14px;letter-spacing:.5px">ENTRO LABS · PMT</p>
<h1 style="margin:0 0 16px;font-size:20px;color:#0f172a">${esc(heading)}</h1>
${paragraphs}${cta}
</td></tr></table>
<p style="margin:16px 0 0;color:#94a3b8;font-size:12px">You can turn off notification emails in Settings → Notifications.</p>
</td></tr></table></body></html>`;
}
