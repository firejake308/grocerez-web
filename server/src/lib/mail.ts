export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void>;
}

/** Prints to stdout instead of sending. The default for local dev (MAIL_PROVIDER=console). */
export class ConsoleMailer implements Mailer {
  async send(to: string, subject: string, text: string): Promise<void> {
    console.log(`[mail:console] to=${to} subject=${JSON.stringify(subject)}\n${text}`);
  }
}

/** Sends through Resend's HTTP API: https://resend.com/docs/api-reference/emails/send-email */
export class ResendMailer implements Mailer {
  constructor(private apiKey: string, private from: string) {}

  async send(to: string, subject: string, text: string): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: this.from, to, subject, text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Resend request failed (${res.status}): ${body}`);
    }
  }
}

export function createMailer(provider: string, apiKey: string, from: string): Mailer {
  if (provider === 'resend') {
    if (!apiKey) throw new Error('RESEND_API_KEY is required when MAIL_PROVIDER=resend');
    return new ResendMailer(apiKey, from);
  }
  return new ConsoleMailer();
}
