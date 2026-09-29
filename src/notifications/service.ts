import { createHmac } from 'node:crypto';

import type { NotificationEvent } from './types.js';

/**
 * Header carrying an HMAC-SHA256 of the request body, keyed with
 * `NOTIFY_WEBHOOK_SECRET`, so a receiver can tell a real notification from
 * one posted by anybody who happened to learn the webhook URL. Lower-case
 * hex, no prefix. See the "Notification events" section of the README for
 * the receiver-side verification recipe.
 */
const SIGNATURE_HEADER = 'x-streamgive-signature';

async function notifyWebhook(event: NotificationEvent): Promise<void> {
  const webhookUrl = process.env.NOTIFY_WEBHOOK_URL;
  if (!webhookUrl) return;

  // Serialised once and reused as both the signed input and the request
  // body. Signing a second `JSON.stringify(event)` would work today but
  // couples the signature to key ordering staying identical between two
  // calls — the receiver verifies against the raw bytes it read off the
  // wire, so those bytes are what has to be signed.
  const body = JSON.stringify(event);

  const headers: Record<string, string> = { 'content-type': 'application/json' };

  // Read per call rather than at module load so deployments can rotate the
  // secret without a restart, and so tests can set it per case.
  const secret = process.env.NOTIFY_WEBHOOK_SECRET;
  if (secret) {
    headers[SIGNATURE_HEADER] = createHmac('sha256', secret).update(body).digest('hex');
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body,
    });

    if (!res.ok) {
      console.error(`webhook notification failed with status ${res.status} for ${webhookUrl}`);
    }
  } catch (err) {
    console.error('webhook notification failed', err);
  }
}

/** Stub: no email provider wired up yet — picking one (SendGrid, Postmark,
 * Resend, ...) is a separate decision. `notify()` below is the only thing
 * the rest of the app calls, so swapping this out later touches no call
 * sites. */
async function notifyEmail(event: NotificationEvent): Promise<void> {
  console.log('[notify:email:stub]', event);
}

export async function notify(event: NotificationEvent): Promise<void> {
  await Promise.all([notifyWebhook(event), notifyEmail(event)]);
}
