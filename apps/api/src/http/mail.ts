/**
 * The unsubscribe link in result and referral mail.
 *
 *   GET  /mail/unsubscribe?t=…   a person following the link: a short page
 *   POST /mail/unsubscribe?t=…   a mail client's one-click button (RFC 8058)
 *
 * Both turn mail off and nothing else; the token is good for no more than
 * that, so a forwarded mail can do no harm. Turning it back on is a switch on
 * the account page.
 */

import { Hono } from 'hono';

import type { AccountStore } from '../auth/accountStore.js';

export function mailRoutes(accounts: AccountStore, appOrigin: string) {
  const page = (title: string, body: string) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${title}</title></head>` +
    `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.25rem;color:#17181F;background:#F6F2EA">` +
    `<h1 style="font-size:1.6rem">${title}</h1><p style="line-height:1.5;color:#5F6272">${body}</p>` +
    `<p><a href="${appOrigin}/account" style="color:#4A41D4;font-weight:700">Open Stubby</a></p></body></html>`;

  return new Hono()
    .get('/unsubscribe', async (c) => {
      const done = await accounts.unsubscribeMail(c.req.query('t') ?? '');
      return done
        ? c.html(
            page(
              'You will not get these emails',
              'No more draw results or referral news. Sign-in links still arrive when you ask for one. Turn them back on from your account.',
            ),
          )
        : c.html(page('That link is not valid', 'It may be incomplete. Nothing was changed.'), 404);
    })
    .post('/unsubscribe', async (c) => {
      const done = await accounts.unsubscribeMail(c.req.query('t') ?? '');
      return done ? c.body(null, 200) : c.body(null, 404);
    });
}
