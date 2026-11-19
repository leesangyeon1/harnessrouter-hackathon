# Admin quant emulator

Open **Quant emulator** in the operations sidebar. Load the sample bundle, inspect its full identities, then click **Run sample evaluation** once. Sample mode explicitly requests the backend's synthetic 260-bar series with its default symbol. Loading the bundle and opening history do not start runs.

The panel uses the customer emulator's existing bundle/prompt, task API and nested/flat candidate metric contracts. It polls task detail rather than opening a second execution path. The server forwards only these operations:

- `GET /v1/agent-tasks/quant-bundle?symbol=…&mode=…`
- `POST /v1/agent-tasks` with exactly `input` and `feature_key: quant_eval`
- `GET /v1/agent-tasks?feature_key=quant_eval`
- `GET /v1/agent-tasks/{uuid}` for a quant task

Each proxy rechecks the current backend admin role. POST additionally requires the configured admin Origin. Redirects are refused, authenticated responses are private and uncached, and mutations are never retried automatically. No files, previews, events, follow-ups, cancellation, jobs or orders are proxied. Automatic detail refresh stops after 120 five-second intervals; reopening a stored run reads its current status without submitting another run.

Results belong to the signed-in administrator, using the existing server-side `agent_tasks` persistence. Reopen a run from history after signing into a fresh browser session to verify its readback. History is scoped to the caller, not a global administrative task catalogue.

Metrics, winners, simulation labels and result identities are what the HarnessRouter agent reported. The API stores the answer and does not recompute it with `finance_core`. Candidate order and raw ratio values are preserved. Unknown values remain unknown; an explicit null winner stays null. An answer that does not parse shows an explicit state and the exact stored answer, with no inferred rankings. Input bundle identities and agent-reported identities have separate labels. Reopened results do not substitute a newly loaded input bundle for the stored answer's identities.

No new environment variables: existing `INTERNAL_API_BASE_URL` and `ADMIN_APP_ORIGIN` apply. See [hosting handoff](../web/HOSTING.md) for the separate admin image and deployment configuration. A dev push triggers the repository's deployment workflow; a PR build is not deployment evidence.

Validation uses synthetic fixtures: admin unit tests cover the proxy boundary and metric handling; `apps/web/tests/admin-quant.spec.ts` covers one submission, a fresh-context history read, role/Origin denial and an unparseable stored answer. These tests do not prove a real HarnessRouter evaluation or deployed administrator sign-in.
