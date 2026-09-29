import { createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { notify } from '../../src/notifications/service.js';
import type { NotificationEvent } from '../../src/notifications/types.js';

describe('notify', () => {
  const originalEnv = process.env.NOTIFY_WEBHOOK_URL;
  const originalSecret = process.env.NOTIFY_WEBHOOK_SECRET;

  beforeEach(() => {
    vi.restoreAllMocks();
    // Unset by default so the signing cases opt in explicitly and a stray
    // value in the developer's own .env can't make them pass for free.
    delete process.env.NOTIFY_WEBHOOK_SECRET;
  });

  afterEach(() => {
    process.env.NOTIFY_WEBHOOK_URL = originalEnv;
    if (originalSecret === undefined) {
      delete process.env.NOTIFY_WEBHOOK_SECRET;
    } else {
      process.env.NOTIFY_WEBHOOK_SECRET = originalSecret;
    }
  });

  it('logs status code and URL when webhook returns a non-2xx response (500)', async () => {
    const webhookUrl = 'http://example.com/webhook';
    process.env.NOTIFY_WEBHOOK_URL = webhookUrl;

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 500, statusText: 'Internal Server Error' }),
    );

    const event: NotificationEvent = {
      type: 'stream_created',
      streamId: '1',
      donorAddress: 'GDONOR',
      ngoId: 'NGO1',
    };

    await notify(event);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/500.*http:\/\/example\.com\/webhook/),
    );
  });

  describe('webhook signature', () => {
    const event: NotificationEvent = {
      type: 'stream_created',
      streamId: '1',
      donorAddress: 'GDONOR',
      ngoId: 'NGO1',
    };

    /** Captures the single fetch the webhook notifier makes. */
    function captureWebhookRequest() {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(null, { status: 204 }));
      vi.spyOn(console, 'log').mockImplementation(() => {});
      return fetchSpy;
    }

    it('signs the body with an HMAC-SHA256 of NOTIFY_WEBHOOK_SECRET', async () => {
      process.env.NOTIFY_WEBHOOK_URL = 'http://example.com/webhook';
      process.env.NOTIFY_WEBHOOK_SECRET = 'a-shared-secret';

      const fetchSpy = captureWebhookRequest();

      await notify(event);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      const body = init.body as string;

      // Recomputed here from the secret and the bytes actually sent, rather
      // than compared against a hard-coded digest — that way the assertion
      // stays true if the payload shape changes, and still fails if the
      // service ever signs something other than what it transmits.
      const expected = createHmac('sha256', 'a-shared-secret').update(body).digest('hex');

      expect(headers['x-streamgive-signature']).toBe(expected);
    });

    it('signs the exact bytes sent as the body, not a re-serialisation', async () => {
      process.env.NOTIFY_WEBHOOK_URL = 'http://example.com/webhook';
      process.env.NOTIFY_WEBHOOK_SECRET = 'a-shared-secret';

      const fetchSpy = captureWebhookRequest();

      await notify(event);

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      const signature = headers['x-streamgive-signature'];

      // A receiver only ever has the raw body — this is that verification,
      // done the way the README tells integrators to do it.
      const verified = createHmac('sha256', 'a-shared-secret')
        .update(Buffer.from(init.body as string, 'utf8'))
        .digest('hex');

      expect(signature).toBe(verified);
      expect(JSON.parse(init.body as string)).toEqual(event);
    });

    it('rejects a tampered body: the signature no longer matches', async () => {
      process.env.NOTIFY_WEBHOOK_URL = 'http://example.com/webhook';
      process.env.NOTIFY_WEBHOOK_SECRET = 'a-shared-secret';

      const fetchSpy = captureWebhookRequest();

      await notify(event);

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;

      const forged = JSON.stringify({ ...event, ngoId: 'ATTACKER-NGO' });
      const forgedDigest = createHmac('sha256', 'a-shared-secret').update(forged).digest('hex');

      expect(forgedDigest).not.toBe(headers['x-streamgive-signature']);
    });

    it('omits the signature header when no secret is configured', async () => {
      process.env.NOTIFY_WEBHOOK_URL = 'http://example.com/webhook';

      const fetchSpy = captureWebhookRequest();

      await notify(event);

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;

      expect(headers['x-streamgive-signature']).toBeUndefined();
      expect(headers['content-type']).toBe('application/json');
    });
  });
});
