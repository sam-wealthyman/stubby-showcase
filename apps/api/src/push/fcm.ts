/**
 * Sending push through Firebase Cloud Messaging's HTTP v1 API.
 *
 * No SDK: a service account signs a short JWT (RS256, Node's own crypto), which
 * Google's token endpoint trades for an hour's access token, cached here. That
 * is the whole of the auth, and it keeps a heavy dependency out of the API.
 *
 * The service account file is a secret. It is read from a path given in the
 * environment (FCM_SERVICE_ACCOUNT_FILE) and never logged.
 */

import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

export interface PushMessage {
  title: string;
  body: string;
  /** In-app path opened when the notification is tapped, e.g. /won/3. */
  href: string;
}

/** `gone`: the token is dead (app uninstalled, data cleared) and should go. */
export type PushOutcome = 'sent' | 'gone' | 'failed';

export interface PushSender {
  readonly name: string;
  send(token: string, message: PushMessage): Promise<PushOutcome>;
}

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

export function fcmSender(
  serviceAccountFile: string,
  request: typeof fetch = fetch,
  now: () => number = Date.now,
): PushSender {
  const account = JSON.parse(readFileSync(serviceAccountFile, 'utf8')) as ServiceAccount;
  if (!account.project_id || !account.client_email || !account.private_key) {
    throw new Error('FCM_SERVICE_ACCOUNT_FILE is not a Firebase service account key');
  }
  let cached: { token: string; expiresAt: number } | undefined;

  const accessToken = async (): Promise<string> => {
    if (cached && cached.expiresAt - 60_000 > now()) return cached.token;
    const iat = Math.floor(now() / 1000);
    const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
      iss: account.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat,
      exp: iat + 3600,
    })}`;
    const signature = createSign('RSA-SHA256')
      .update(unsigned)
      .sign(account.private_key, 'base64url');
    const response = await request(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${signature}`,
      }).toString(),
    });
    if (!response.ok) throw new Error(`fcm auth failed: ${response.status}`);
    const json = (await response.json()) as { access_token: string; expires_in: number };
    cached = { token: json.access_token, expiresAt: now() + json.expires_in * 1000 };
    return cached.token;
  };

  return {
    name: `fcm ${account.project_id}`,
    async send(token, message) {
      const response = await request(
        `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${await accessToken()}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            message: {
              token,
              notification: { title: message.title, body: message.body },
              data: { href: message.href },
              android: { priority: 'high', notification: { channel_id: 'results' } },
            },
          }),
        },
      );
      if (response.ok) return 'sent';
      // FCM's documented answer for a token that no longer reaches an app.
      if (response.status === 404) return 'gone';
      const text = await response.text().catch(() => '');
      if (/UNREGISTERED|registration-token-not-registered/.test(text)) return 'gone';
      // A token FCM cannot parse will never reach anything either.
      if (response.status === 400 && /INVALID_ARGUMENT/.test(text) && /token/i.test(text)) {
        return 'gone';
      }
      return 'failed';
    },
  };
}

/** Development and tests: record instead of sending. */
export function recordingSender(): PushSender & {
  sent: { token: string; message: PushMessage }[];
} {
  const sent: { token: string; message: PushMessage }[] = [];
  return {
    name: 'recording',
    sent,
    async send(token, message) {
      sent.push({ token, message });
      return 'sent';
    },
  };
}
