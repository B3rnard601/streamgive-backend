import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '../../src/db.js';
import { notify } from '../../src/notifications/service.js';
import type { NotificationEvent } from '../../src/notifications/types.js';
import { resetDb } from '../helpers/db.js';

const event: NotificationEvent = {
  type: 'stream_created',
  streamId: '1',
  donorAddress: 'GDONOR',
  ngoId: 'NGO1',
};

describe('notify', () => {
  const originalEnv = process.env.NOTIFY_WEBHOOK_URL;

  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetDb();
  });

  afterEach(() => {
    process.env.NOTIFY_WEBHOOK_URL = originalEnv;
  });

  it('logs status code and URL when webhook returns a non-2xx response (500)', async () => {
    const webhookUrl = 'http://example.com/webhook';
    process.env.NOTIFY_WEBHOOK_URL = webhookUrl;

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 500, statusText: 'Internal Server Error' }),
    );

    await notify(event);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/500.*http:\/\/example\.com\/webhook/),
    );
  });

  it('writes a failure record when webhook returns non-2xx', async () => {
    process.env.NOTIFY_WEBHOOK_URL = 'http://example.com/webhook';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 500, statusText: 'Internal Server Error' }),
    );

    await notify(event);

    const log = await prisma.notificationLog.findFirst({
      where: { channel: 'webhook', success: false },
    });
    expect(log).not.toBeNull();
    expect(log?.eventType).toBe('stream_created');
    expect(log?.error).toMatch(/500/);
  });

  it('writes a success record when webhook returns 2xx', async () => {
    process.env.NOTIFY_WEBHOOK_URL = 'http://example.com/webhook';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));

    await notify(event);

    const log = await prisma.notificationLog.findFirst({
      where: { channel: 'webhook', success: true },
    });
    expect(log).not.toBeNull();
    expect(log?.eventType).toBe('stream_created');
  });

  it('writes an email record on every notify call', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await notify(event);

    const log = await prisma.notificationLog.findFirst({ where: { channel: 'email' } });
    expect(log).not.toBeNull();
    expect(log?.success).toBe(true);
  });
});
