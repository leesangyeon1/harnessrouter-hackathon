# Synthetic webpage context for the advisor

New advisor comparisons include a selected synthetic webpage scenario by default. The user can inspect its exact figures before submitting. The three presets are independent alternatives, not simultaneous loans or real offers. Custom calculator requests switch to the existing request-only mode; they do not silently borrow another scenario's webpage data.

The shared `ADVISOR_SCENARIOS` definitions drive the preset labels, goals, terms and deterministic calculator outputs. The context also projects only the public sample account labels/types/balances and sample spending categories from `demo.ts`. It never accepts a profile, bank/provider object, account identifier, credential, private memory or uploaded financial record.

Public read routes:

- `/advisor/context/v1/{scenario}` — server-rendered HTML, readable without JavaScript or sign-in.
- `/advisor/context/v1/{scenario}/snapshot.json` — the same payload and canonical SHA-256.

Supported scenario IDs: `balance-transfer`, `refinance-term-tradeoff`, `refinance-same-term`. A request carries the selected scenario ID, version, goal and SHA, plus both source URLs with `?sha=…`. The JSON route returns409 when that requested hash differs. Unknown scenarios return404. The client rejects changed or additional projected fields and blocks submission when the sample context cannot be loaded; it never quietly sends an ungrounded request instead.

The snapshot pins `advisor-demo-v1` and calculator policy `monthly-cents-v1`. Card interest is rounded monthly to cents and the transfer fee is financed. Loan comparisons use a rounded fixed monthly payment times the term, with refinance fees paid upfront. Calculator verification means deterministic fixture checks, not lender verification, affordability assessment or live provider evidence. Tests include the USD card payoff figures and the longer-term refinance's lower-payment/higher-total-cost tradeoff. Change the context version and route version when changing its published assumptions or figures.

The HarnessRouter advisor must actually read the synthetic page or JSON using its supported read-only web tool, match the scenario/version/hash and use that scenario's calculator outputs. A URL in the input, a successful browser mock, or an agent statement that it read a page is not sufficient proof. Verify the actual tool call/result separately; if unavailable, report the exact tool or policy limitation. Do not claim network isolation. No unrelated workspace memory, database, broker or bank access is needed.

This frontend change does not modify live HarnessRouter configuration or backend credentials. Coordinate required advisor policy/tool changes with the API owner, following the repository's live-fetch/full-replace/readback process. Keys stay server-side. No new frontend environment variables; source URLs use the current customer app origin. The separate admin security hold remains in effect.
