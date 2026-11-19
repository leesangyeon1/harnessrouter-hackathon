# Stored synthetic scenario context for the advisor

Owner correction, room message `4e7f6f26-91da-4225-897a-1504094bf3ad`: “not reading the page, retrived the hardcoded db for the anayltic.” This supersedes the earlier webpage-read requirement. New analyses select a seeded synthetic database scenario. HarnessRouter receives the server's projected financial inputs, comparison goal, option terms and deterministic calculator outputs. It does not need a webpage, SQL credentials, private account access or workspace memory.

## Integration contract

The customer API retrieves the selected stored record using authenticated `GET /v1/agent-tasks/advisor-context?scenario_id=…`. The response contains `payload`, canonical `sha256` and `storage` metadata (`kind: postgresql`, `seed_version`, `record_id`). The UI verifies the declared schema/projection and hash, then displays the actual retrieved goal, inputs, outputs and record/version identity. It does not compare the figures with a frontend constant or substitute one when retrieval fails.

`POST /v1/agent-tasks` carries the user's question, `feature_key: advisor` and `advisor_context: {scenario_id, scenario_version, sha256}`. The server must reload that record, reject a missing or changed selection before creating the task, and build the analysis input from the stored projection. The client does not submit authoritative financial figures or a page URL. A stale selection requires a deliberate reload and a new submission; no mutation is automatically replayed.

The three synthetic comparisons retain the previously tested monthly-cent calculator assumptions: a card transfer, a longer refinance term with lower payment but higher total cost, and a same-term refinance. They are independent alternatives, not simultaneous debts or live offers. Income, affordability, eligibility and actual promotional expiration remain unknown. Custom calculator comparisons are separately labelled request-only and do not claim DB retrieval.

## Database source and evidence

Migration `apps/api/src/finance_api/migrations/0011_advisor_demo_db.sql` stores three global reference rows in `advisor_demo_scenarios`. Their seed/version is `advisor-db-demo-v1`, schema `harness.advisor.db-context.v1`, origin `seeded_synthetic_db`. The API role has SELECT access only. The composite record identity is `scenario_id@scenario_version`. The versioned migration contains the normalized inputs and already computed, fixture-verified outputs; it does not manufacture current lender offers. New versions require a new approved seed/migration.

`finance_api.advisor_demo_db.read_scenario` performs the SQL lookup and validates a closed projection, scenario/calculator kind, metadata identity and hash. It never loads a fallback fixture file. The normal agent-task route reloads the record within the submission transaction, compares the selected identity, then stores/transmits the resulting input. Missing records return404, stale selections409, and absent/corrupt seed data503. The JSON under `tests/` remains only a transport fixture, not database-query evidence.

Local PostgreSQL tests remove the stored row and observe404, verify the runtime role cannot update it, reject unexpected private fields, and capture the exact DB snapshot in the normal task's provider request and stored query. That provider boundary is mocked; a genuine DB-backed recommendation and live UI readback must be recorded separately after deployment.

Acceptance requires the actual migration/seed and record/version, a server query/projection test, the exact transmitted context and a real recommendation through the normal app path. The previous terminal webpage-read probe establishes none of those DB-specific claims. Legacy public synthetic HTML/JSON routes remain for the earlier demo; this analysis flow never requests them.

## Hosting and boundaries

No new browser environment variables are needed. The API uses its server-side database pool and existing HarnessRouter credential. Never provide either credential to the agent or browser. Only explicitly projected synthetic scenario fields may enter agent input; no raw Plaid/broker payload, account identifier, real financial record or secret is permitted. Network isolation is not claimed. The separate admin security hold remains unchanged.
