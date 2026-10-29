/**
 * Outbound notification email (alerts, scheduled reports, password resets).
 * remail never sends from the monitored mailboxes. Options, in order of preference:
 *   1. SMTP (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS)  — e.g. Microsoft 365 SMTP AUTH, SendGrid, SES
 *   2. Resend API (RESEND_API_KEY)
 *   3. Microsoft Graph sendMail from one dedicated notifications mailbox (MS_SENDER_MAILBOX).
 *      This is the only write permission in the solution and is scoped to that single mailbox.
 */
import nodemailer from 'nodemailer';
import { microsoftSendMail } from './connectors/microsoft';

export function mailerProvider(): 'smtp' | 'resend' | 'graph' | 'none' {
	if (process.env.SMTP_HOST) return 'smtp';
	if (process.env.RESEND_API_KEY) return 'resend';
	if (process.env.MS_SENDER_MAILBOX && process.env.MS_CLIENT_ID) return 'graph';
	return 'none';
}

const FROM = () => process.env.MAIL_FROM || 'remail <remail@notifications.ravity.io>';

export async function sendEmail(to: string[], subject: string, html: string): Promise<'sent' | 'skipped'> {
	const recipients = [...new Set(to.map((t) => t.trim()).filter((t) => /@/.test(t)))];
	if (!recipients.length) return 'skipped';
	const p = mailerProvider();
	if (p === 'none') {
		console.log(`[mailer] no provider configured — would send "${subject}" to ${recipients.join(', ')}`);
		return 'skipped';
	}
	if (p === 'smtp') {
		const t = nodemailer.createTransport({
			host: process.env.SMTP_HOST,
			port: Number(process.env.SMTP_PORT || 587),
			secure: Number(process.env.SMTP_PORT) === 465,
			auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
		});
		await t.sendMail({ from: FROM(), to: recipients, subject, html });
		return 'sent';
	}
	if (p === 'resend') {
		const res = await fetch('https://api.resend.com/emails', {
			method: 'POST',
			headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
			body: JSON.stringify({ from: FROM(), to: recipients, subject, html }),
		});
		if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
		return 'sent';
	}
	await microsoftSendMail(process.env.MS_SENDER_MAILBOX!, recipients, subject, html);
	return 'sent';
}

export async function postWebhook(kind: 'teams' | 'slack', title: string, text: string, link?: string) {
	const url = kind === 'teams' ? process.env.TEAMS_WEBHOOK_URL : process.env.SLACK_WEBHOOK_URL;
	if (!url) return 'skipped';
	const body =
		kind === 'slack'
			? { text: `*${title}*\n${text}${link ? `\n<${link}|Open in remail>` : ''}` }
			: {
				type: 'message',
				attachments: [{
					contentType: 'application/vnd.microsoft.card.adaptive',
					content: {
						type: 'AdaptiveCard', version: '1.4', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
						body: [
							{ type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium', wrap: true, color: 'Attention' },
							{ type: 'TextBlock', text, wrap: true },
						],
						actions: link ? [{ type: 'Action.OpenUrl', title: 'Open in remail', url: link }] : [],
					},
				}],
			};
	const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
	return res.ok ? 'sent' : `error ${res.status}`;
}

export const appUrl = () => (process.env.APP_URL || process.env.URL || 'http://localhost:5173').replace(/\/$/, '');

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
export { esc };

/** Branded wrapper for all outgoing HTML email (inline styles for email clients). */
export function emailLayout(title: string, inner: string) {
	return `<!doctype html><html><body style="margin:0;background:#F4F5F9;font-family:'Nunito Sans',Segoe UI,Arial,sans-serif;color:#0B1143">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F4F5F9;padding:24px 0"><tr><td align="center">
<table width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%">
<tr><td style="background:#0B1143;border-radius:16px 16px 0 0;padding:20px 28px">
<span style="font-family:Nunito,Segoe UI,Arial,sans-serif;font-weight:700;font-size:20px;color:#fff"><span style="color:#F00D69">re</span>mail</span>
<span style="color:#9aa3c7;font-size:13px;margin-left:8px">AI email intelligence</span></td></tr>
<tr><td style="background:#fff;border-radius:0 0 16px 16px;padding:28px;box-shadow:0 0 3rem rgba(0,0,0,.085)">
<h1 style="font-family:Nunito,Segoe UI,Arial,sans-serif;font-size:22px;margin:0 0 16px;color:#0B1143">${title}</h1>
${inner}
<p style="font-size:12px;color:#8a90a8;margin-top:28px;border-top:1px solid #eceef5;padding-top:14px">Sent by remail, powered by Ravity. You receive this because you are on the distribution list. <a href="${appUrl()}" style="color:#4C80FF">Open remail</a></p>
</td></tr></table></td></tr></table></body></html>`;
}
