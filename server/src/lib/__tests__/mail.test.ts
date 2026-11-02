import { describe, expect, it, vi } from 'vitest';
import { ConsoleMailer, ResendMailer, createMailer } from '../mail.js';

describe('ResendMailer', () => {
  it('posts the message to the Resend API with a bearer key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"id":"1"}', { status: 200 }));
    const mailer = new ResendMailer('re_key', 'GrocerEZ <a@b.c>', fetchMock as unknown as typeof fetch);
    await mailer.send('x@y.z', 'Hi', 'body');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer re_key');
    expect(JSON.parse(init.body)).toEqual({ from: 'GrocerEZ <a@b.c>', to: 'x@y.z', subject: 'Hi', text: 'body' });
  });

  it('throws with status and body when Resend rejects', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('bad domain', { status: 403 }));
    const mailer = new ResendMailer('k', 'f', fetchMock as unknown as typeof fetch);
    await expect(mailer.send('x@y.z', 's', 't')).rejects.toThrow(/403.*bad domain/);
  });
});

describe('createMailer', () => {
  it('builds a Resend mailer (case-insensitive)', () => {
    expect(createMailer('Resend', 'k', 'f')).toBeInstanceOf(ResendMailer);
  });
  it('requires an API key for resend', () => {
    expect(() => createMailer('resend', '', 'f')).toThrow(/RESEND_API_KEY/);
  });
  it('defaults to console', () => {
    expect(createMailer('console', '', 'f')).toBeInstanceOf(ConsoleMailer);
    expect(createMailer('', '', 'f')).toBeInstanceOf(ConsoleMailer);
  });
  it('rejects unknown providers instead of silently using console', () => {
    expect(() => createMailer('sendgrid', '', 'f')).toThrow(/Unknown MAIL_PROVIDER/);
  });
});
