# Harness customer web

An original personal-finance interface inspired by Rocket Money's approachable dashboard patterns: warm neutrals, coral actions, calm green accents, clear balances and spending charts. This is the customer build. The independently deployed operations app is in [`../admin`](../admin/README.md).

## Run

Use Node 22 or later and npm. From this directory:

```sh
npm ci
cp .env.example .env.local
npm run dev -- --port 3100
```

Open http://127.0.0.1:3100. The default workspace is an explicitly labelled, read-only synthetic preview. Identity configuration is optional for preview. Set the public API and Identity Platform configuration to enable real sign-in. Changing `NEXT_PUBLIC_*` values requires restarting development or rebuilding production.

## Current backend compatibility

| Interaction                               | Existing backend contract                                                                                      |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Sign in / create account / reset password | Firebase browser SDK against the configured Identity Platform project; email/password provider must be enabled |
| Verify account                            | `GET /v1/me`, fresh Firebase ID token as bearer                                                                |
| Connect Sandbox profile                   | `POST /v1/plaid/seed`, then sync and compute; an existing-profile 409 proceeds to sync                         |
| Refresh provider data                     | `POST /v1/plaid/sync`                                                                                          |
| Read spending                             | `GET /v1/reports/spending`; 404 is an empty report                                                             |
| Compute spending                          | `POST /v1/reports/spending`                                                                                    |
| Read latest sector screen                 | `GET /v1/cycles/latest`; 404 is no published cycle; sign-in does not require a Plaid profile                   |

Spending DTOs retain backend decimal strings and convert to integer cents with bounds checking before aggregation. GET and POST responses are validated. Requests omit cookies, disable caching, refuse redirects, refresh the token through Firebase and time out. Provider errors display a retry action and preserve the last report. Sign-out clears customer state; stale in-flight responses cannot repopulate it.

The sync response must include boolean `transactions_ready` and an `unavailable` object. While transactions are preparing, no spending report is computed, existing totals/exports are hidden, and the page offers **Retry sync**. Each click makes one sync request, reuses the existing Sandbox Item, and computes a fresh report only when readiness is true; there is no automatic polling loop. A ready report with no categories has its own explicit state. Named unavailable liabilities/holdings are shown as **not available from Plaid**, with the provider code and a notice that previously stored rows remain unchanged; their counts are never presented as zero availability. Token renewal for the same identity retains these known states. Changing identity or signing out clears them. Missing or malformed readiness/availability data fails validation instead of defaulting to ready. This follows the backend contract at `bfd083e`, tested with synthetic transports rather than real Sandbox calls.

Overview, spending, accounts, cards/loans, paper investing, discovery and settings share the same responsive shell. Search, mobile navigation, dialogs, CSV export, report month selection and Sandbox connect/sync are implemented. Preview figures are never substituted for missing live data. Account/transaction listings, card/loan reports, portfolios, model-performance leaderboards and policy changes do not yet have customer read APIs in this backend snapshot: authenticated views explain the missing data instead of inventing it. Preview watchlists and paper-mode comparisons are local illustrations; they do not place orders or persist policy changes. The preview net-worth chart and allocations are synthetic, not backtest output.

Authenticated Market Discovery reads the latest stored cycle. It displays the cycle date, stored model-set and policy versions, and each sector's actual universe, feed, all supplied coverage counts, selections and named exclusions. Figures remain exact decimal strings, including scientific notation, in published order. Omitted sectors/counts stay unavailable; a published empty selection is distinct from missing data. Loading, 404 and recoverable failure have separate states, and a failed refresh retains the last retrieved screen with a notice. The screen is qualified by its provider universe/feed and never labelled complete or market-wide. It supplies no model-performance winners or cycle-ID-based leaderboard. Stored versions come from the API, with no assumption that mode policies or bond lists start empty.

## Verify

```sh
npm run check
npm --prefix ../admin ci
npm --prefix ../admin run check
npx playwright test
```

Playwright uses installed Chrome by default and starts the two web apps plus a local HTTP fixture. For CI without Chrome, run `npx playwright install --with-deps chromium` and set `PLAYWRIGHT_USE_BUNDLED=1`. Ports 3100, 3101 and 4319 must be free. Unit tests cover API shapes, decimal arithmetic, auth headers, redirects and error handling. Browser tests cover desktop/mobile navigation, CSV, dialogs, all customer views with axe WCAG AA checks, loading/empty/error/partial/report states, Sandbox fixture flows, admin denial, CSRF, token issue/revoke and immediate role removal. Test identity and API responses are synthetic and do not prove real Identity Platform, Plaid, Alpaca, HarnessRouter or cloud integration.

Rendered captures and their observations are in [`evidence`](evidence/report.json). Hosting variables, separate app deployment instructions and environment-owner handoff are in [`HOSTING.md`](HOSTING.md). The design contract is in [`DESIGN.md`](DESIGN.md).

Both app lockfiles pin Firebase 12.6 for Node 22 compatibility and override its unused Firestore gRPC dependency to `@grpc/grpc-js` 1.14.7. This removes the vulnerable 1.9.x transitive install found by `npm audit`; only Firebase app/auth modules are imported by these apps. Production dependency audits pass for both lockfiles.
