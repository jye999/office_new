// Nodemailer stand-in for Laravel's Mail facade (mailgun SMTP in the old app).
// Safety rule: no-op + log unless MAIL_ENABLED=1.

import * as nodemailer from 'nodemailer';

export interface MailOptions {
  from: string;
  fromName?: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  html: string;
}

function transport(): nodemailer.Transporter {
  return nodemailer.createTransport({
    host: process.env.MAIL_HOST ?? '',
    port: Number(process.env.MAIL_PORT ?? 587),
    secure: Number(process.env.MAIL_PORT ?? 587) === 465,
    auth: { user: process.env.MAIL_USERNAME ?? '', pass: process.env.MAIL_PASSWORD ?? '' },
  });
}

export async function sendMail(options: MailOptions): Promise<void> {
  if (process.env.MAIL_ENABLED !== '1') {
    console.log(
      `[mail disabled] to=${Array.isArray(options.to) ? options.to.join(',') : options.to} subject="${options.subject}" (${options.html.length} bytes)`,
    );
    return;
  }
  const from = options.fromName ? `${options.fromName} <${options.from}>` : options.from;
  await transport().sendMail({ ...options, from });
}
