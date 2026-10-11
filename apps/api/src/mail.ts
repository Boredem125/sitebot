import type { Env } from './env';

const RESEND_URL = 'https://api.resend.com/emails';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

/**
 * Sends one plain-text mail through Resend. True when Resend accepted it. Without
 * RESEND_API_KEY and MAIL_FROM nothing is sent and no request is made.
 */
export async function sendMail(env: Pick<Env, 'RESEND_API_KEY' | 'MAIL_FROM'>, mail: Mail): Promise<boolean> {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) return false;
  try {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [mail.to], subject: mail.subject, text: mail.text }),
    });
    // The response body is dropped unread: it can echo the recipient and the message.
    await res.body?.cancel().catch(() => {});
    // Status only. The key, the recipient, and the text (which may carry a secret link) stay out of logs.
    if (!res.ok) console.error('mail: send failed, status', res.status);
    return res.ok;
  } catch {
    console.error('mail: send failed, no response');
    return false;
  }
}
