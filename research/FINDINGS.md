# Transport from a userscript on torn.com (verified 2026-11-03 in Chrome + Tampermonkey 5.5.1)

- Torn's CSP `connect-src` allows only Torn/Google/etc hosts. From a userscript (even `@sandbox DOM`),
  `fetch` and `new WebSocket` to another host fail (`Failed to fetch`, WebSocket `error` event).
- `GM_xmlhttpRequest` with `@connect <host>` works, and `responseType: 'stream'` delivers a
  Server-Sent Events stream chunk by chunk (first chunk 155 ms, then each event as sent).
- So the client uses SSE over GM_xmlhttpRequest; WebSockets (and DO WebSocket hibernation) are not usable.

# Identity: what the page can and cannot prove (2026-11-03)

- Torn chat's tokens (e.g. in `localStorage['tchat_query_cache:1:<uid>']`) are HS256 JWTs (`sub`, `channel`, `iat`, `exp`):
  only Torn can verify them, and they are chat credentials, so they must never be sent to our server.
- Anything read from the page (`#torn-user`, sidebar profile link, intercepted responses) is reported by the
  client and can be forged by a modified script. Comparing it with the key owner only stops unmodified-script misuse.
- An API key is a bearer credential: any service that stores keys (or any leaked/bought key) can log in as that player
  wherever key = identity. Proof of the browser session needs an action Torn records and our server reads via the API:
  a Torn mail to a bot (`/v2/user/messages`, Limited key) or $1 with a code (`/v2/user/events`). Not built.
