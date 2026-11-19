# Harness Operations

Separate Next.js build and deployment for administrators. The customer app is in [`../web`](../web/README.md); shared hosting/environment instructions are in [`../web/HOSTING.md`](../web/HOSTING.md).

```sh
npm ci
cp .env.example .env.local
npm run dev
npm run check
```

Default development origin: http://127.0.0.1:3101. Set `INTERNAL_API_BASE_URL` to the existing API, `ADMIN_APP_ORIGIN` to this app's exact origin, and the public Identity Platform variables for email/password sign-in. Production requires `ADMIN_APP_ORIGIN`; missing configuration fails closed. Public identity configuration is embedded at build time. API origin and CSRF origin are server runtime values.

The public root is a sign-in page. `proxy.ts` refuses non-admins before `/workspace` renders; the page and each `/api/worker-tokens*` route independently query `GET /v1/me` using the current ID token. The backend database role is authoritative and is rechecked on every request. Anonymous requests redirect to sign-in or receive 401; a verified customer receives 403; unavailable verification denies access. Hidden UI is never the authorization boundary.

`POST /api/session` accepts a Firebase ID token only after server-side admin verification and a same-origin check. The session cookie is HttpOnly, host-scoped, SameSite=Strict, Secure in production and short-lived. Before every credential action, the browser acquires the current Firebase ID token and renews the cookie when a browser identity exists. This works after idle cookie expiry without waiting for a token-change event. Failed renewal blocks the action and never replays a mutation. Full page reloads with expired cookies return to sign-in. All mutations, including logout, check the exact `Origin`; upstream requests refuse redirects and caching. Worker token IDs are UUID validated. The proxy exposes only the existing worker-token collection/item methods, not arbitrary API paths.

Implemented operations are listing, issuing and revoking worker credentials through the existing backend `/v1/admin/worker-tokens` endpoints. Issue/revoke require confirmation; a newly issued secret is shown once in memory and cleared on dismissal. No secret is written to local storage. Cycles, policies and usage views are explicitly unavailable until authorized read APIs exist. No arbitrary job-start action, role-editing interface or live-money action is added.

Unit tests cover fresh role checks, denial, invalid configuration, CSRF origins, constrained IDs, request-time renewal and refusal to replay mutations. The customer app's Playwright suite starts both apps and a synthetic HTTP fixture to exercise server-side denial, session/CSRF, issue/revoke, idle cookie expiry, role removal and mobile accessibility. Those tests do not replace real Identity Platform/provider/deployment proofs. Container and standalone runtime instructions are in the shared hosting guide.
