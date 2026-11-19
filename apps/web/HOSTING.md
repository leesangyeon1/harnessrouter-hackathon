# Frontend hosting and environment handoff

The customer and operations apps are **separate builds and separate services/origins**. They share the existing FastAPI backend. Cloud/environment provisioning belongs to the owner's Antigravity environment workflow; these files prepare the code and configuration, without asserting that services have been deployed. The older root `deploy/README.md` and unified web Terraform/Docker arrangement predate this split; the environment owner must wire a second operations service and its origin rather than putting operations routes into the customer service.

## Configuration

Values in `.env.example` are placeholders, not credentials. Never commit `.env.local` or paste secrets into room messages. All `NEXT_PUBLIC_*` variables are embedded in JavaScript **at build time** and visible to users. An environment-variable change on an already built Cloud Run revision does not replace them; rebuild the image.

| Variable                           | Customer                       | Operations             | Timing and meaning                                                                                                                                                 |
| ---------------------------------- | ------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NEXT_PUBLIC_API_BASE_URL`         | Required for sign-in/API flows | Unused                 | Build; exact public HTTPS API origin, no path or credentials; localhost HTTP allowed only for development                                                          |
| `NEXT_PUBLIC_IDENTITY_PROJECT_ID`  | Required for sign-in           | Required for sign-in   | Build; Identity Platform project ID matching the backend verifier                                                                                                  |
| `NEXT_PUBLIC_FIREBASE_API_KEY`     | Required for sign-in           | Required for sign-in   | Build; public Firebase web API key, restricted to approved origins/APIs; it is not a service-account key                                                           |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | Required for sign-in           | Required for sign-in   | Build; project's configured Firebase auth domain                                                                                                                   |
| `NEXT_PUBLIC_ADMIN_URL`            | Optional                       | Unused                 | Build; link to the separate operations app                                                                                                                         |
| `NEXT_PUBLIC_CUSTOMER_URL`         | Unused                         | Optional               | Build; return link to the separate customer app                                                                                                                    |
| `INTERNAL_API_BASE_URL`            | Reserved, currently unused     | Required               | Runtime server only; reachable HTTPS backend origin; localhost HTTP only for development. Despite the name, use the API's reachable service origin, not a URL path |
| `ADMIN_APP_ORIGIN`                 | Unused                         | Required in production | Runtime; exact browser origin of the operations service, including scheme and optional port. Used for strict same-origin mutation checks; no trailing slash        |
| `PORT`                             | Platform sets                  | Platform sets          | Runtime; defaults to 8080 in the supplied containers                                                                                                               |
| `HOSTNAME`                         | `0.0.0.0`                      | `0.0.0.0`              | Runtime container listen address                                                                                                                                   |

Identity Platform must enable email/password sign-in and include **both** deployed domains in authorized domains. The backend must use the same `IDENTITY_PROJECT_ID` and verify tokens. Creating an identity does not grant administrator access: the backend database role remains authoritative. Provision an admin using the backend's authorized administrative process. No client role claim, email allowlist or hidden menu grants access.

Backend runtime configuration stays on the API/worker services: database URLs, signing/worker secrets, Plaid client/secret and encryption keys, Alpaca PAPER keys, HarnessRouter keys, and provider/runtime configuration from the root README. None belongs in either web build. Operations requires no database credentials and no service-account private key. This implementation forwards user ID tokens to the backend; it does not add Cloud Run IAM service-to-service authentication. If the API requires Cloud Run IAM invocation, the environment owner must provide an appropriate ingress/auth design before this browser flow will work.

## API origin / browser configuration

Set the API's `CORS_ALLOWED_ORIGINS` to the exact customer origin (and approved local development origins), for example `https://customer.example.com`. The customer sends `Authorization` and `Content-Type` headers; retain the existing backend CORS methods/headers and exposed `X-Request-ID`. Operations uses server-to-server fetches, so its backend traffic does not require browser CORS. Its own mutations require `Origin` to equal `ADMIN_APP_ORIGIN`. TLS must terminate correctly at the hosting platform. Do not configure authenticated API redirects: both clients refuse them.

Operations stores the ID token in a host-scoped, HttpOnly, Secure-in-production, SameSite=Strict cookie. Every protected page and API verifies the current backend admin role, with no cached permission result. Before each credential read or mutation, the browser asks Firebase for the current ID token and renews the server cookie when a browser identity exists. Expiration alone does not trigger `onIdTokenChanged`, so operations does not rely on that observer for renewal. A failed renewal blocks the operation; mutations are never automatically replayed. An expired session on a full page reload returns to sign-in. Expired identity tokens fail closed. Refresh-token revocation does not immediately invalidate an already-issued ID token under the current backend verifier; immediate operations access removal uses the database admin role. No refresh token or worker credential is stored by the server; issued worker secrets are shown once and forgotten on dismissal. Do not add response caching for authenticated pages or `/api/*`.

## Container builds

Run from repository root. These are independent Dockerfiles with matching context exclusions; production Node 22 images run as the unprivileged `node` user. Substitute public configuration values from the environment owner, never backend secrets.

```sh
docker build -f apps/web/Dockerfile -t harness-customer \
  --build-arg NEXT_PUBLIC_API_BASE_URL=https://api.example.com \
  --build-arg NEXT_PUBLIC_IDENTITY_PROJECT_ID=project-id \
  --build-arg NEXT_PUBLIC_FIREBASE_API_KEY=public-web-api-key \
  --build-arg NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=project-id.firebaseapp.com \
  --build-arg NEXT_PUBLIC_ADMIN_URL=https://operations.example.com .

docker build -f apps/admin/Dockerfile -t harness-operations \
  --build-arg NEXT_PUBLIC_IDENTITY_PROJECT_ID=project-id \
  --build-arg NEXT_PUBLIC_FIREBASE_API_KEY=public-web-api-key \
  --build-arg NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=project-id.firebaseapp.com \
  --build-arg NEXT_PUBLIC_CUSTOMER_URL=https://customer.example.com .

docker run --rm -p 8081:8080 harness-customer
docker run --rm -p 8082:8080 \
  -e INTERNAL_API_BASE_URL=https://api.example.com \
  -e ADMIN_APP_ORIGIN=http://127.0.0.1:8082 harness-operations
```

For Cloud Run, publish these images to the owner's Artifact Registry and deploy **two** services listening on port 8080. Supply `INTERNAL_API_BASE_URL` and the final `ADMIN_APP_ORIGIN` only to operations at runtime. Web sign-in pages must be reachable by the intended browser users; application authorization still gates operations. Root `/` is a public customer preview or operations sign-in and can be used for startup probes; `/workspace` intentionally redirects/denies anonymous users. Custom domains require corresponding authorized-domain, CORS, link and CSRF-origin updates. The API is a separate existing service, not bundled in either container.

Next standalone output traces from the repository root. Each image includes `.next/standalone`, its own `.next/static` and `public`; starting it uses `node apps/web/server.js` or `node apps/admin/server.js`. Copying only standalone without static/public breaks asset delivery. Public configuration must be provided before `npm run build`.

## Acceptance owned by the deployment environment

After deployment, verify the exact customer origin, API origin and operations origin; email/password sign-in, token refresh and expired sessions; backend CORS; Sandbox seed/sync/report readback; operations anonymous/non-admin denial and role removal; worker token issue/revoke; responsive navigation and static assets. Real provider payloads and deployed U0/U8 proofs remain separate from local fixture tests. No live-funds endpoint or job-start permission is introduced here.

Official deployment and auth source links, including standalone asset copying, Cloud Run's port contract and token-refresh semantics, are recorded in [`REFERENCES.md`](REFERENCES.md).
