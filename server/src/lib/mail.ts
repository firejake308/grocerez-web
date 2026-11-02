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
  constructor(
    private apiKey: string,
    private from: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async send(to: string, subject: string, text: string): Promise<void> {
    const res = await this.fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: this.from, to, subject, text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Resend request failed (${res.status}): ${body}`);
    }
  }
}

export function createMailer(provider: string, apiKey: string, from: string): Mailer {
  const name = provider.trim().toLowerCase();
  if (name === 'resend') {
    if (!apiKey) throw new Error('RESEND_API_KEY is required when MAIL_PROVIDER=resend');
    return new ResendMailer(apiKey, from);
  }
  if (name === 'console' || name === '') return new ConsoleMailer();
  // Fail loudly: silently falling back to console would drop real sign-in emails.
  throw new Error(`Unknown MAIL_PROVIDER "${provider}" (expected "resend" or "console")`);
}
