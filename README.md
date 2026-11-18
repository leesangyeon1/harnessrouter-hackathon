# harnessrouter-hackathon
Hackathon Project for harnessrouter.

A finance platform MVP: Plaid Sandbox reports, a daily screen of stocks, bond ETFs and crypto on
Alpaca data, ten quant models backtested on the owner's CPU nodes, and paper orders on Alpaca in
one of two modes. Sandbox and paper data only.

## Layout

| Path | What |
| --- | --- |
| `apps/api` | `finance_api`: the FastAPI service and the SQL migrations |
| `packages/finance-core` | `finance_core`: the models, backtest, selectors, screen, reports and sizing. No I/O |
| `packages/quant-worker` | `quant_worker`: the loop that runs on the owner's nodes |

## The gate

Requires [uv](https://docs.astral.sh/uv/) and `make`. Python 3.12 is installed by uv.

```sh
make gate   # lint, type, test
make lint   # ruff check, ruff format --check
make type   # mypy --strict
make test   # pytest
```

The tests need a real PostgreSQL, because they prove row-level security. `make test` starts one
for the session. To use a server of your own, set `TEST_DATABASE_URL` to a superuser URL.

## Running the API

```sh
DATABASE_URL=<migration role's URL> uv run --all-packages python -m finance_api.migrate
DATABASE_URL=<API role's URL> IDENTITY_PROJECT_ID=<project id> \
PLAID_CLIENT_ID=<id> PLAID_SECRET=<Sandbox secret> SECRET_BOX_KEY=<Fernet key> \
  uv run --all-packages uvicorn finance_api.app:app_from_env --factory
```

`SECRET_BOX_KEY` seals Plaid access tokens at rest. Generate one with
`python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` and
keep it in Secret Manager. Plaid is reached at `sandbox.plaid.com` only: the service refuses to
start if `PLAID_HOST` names any other host.

## Running a worker on a node

An admin issues a token with `POST /v1/admin/worker-tokens`; the response is the only place the
token appears. The node needs that token and the API's address, and nothing else:

```sh
WORKER_API_URL=https://<api host> WORKER_TOKEN=<token> uv run --all-packages quant-worker
```

The worker claims a unit, reads its bars, runs every model and both selectors, and uploads the
result. It makes outbound requests only.

## Database roles

The migrations create the roles `finance_api`, `finance_cycle` and `finance_executor` without a
login. The role that runs them owns every table and needs `CREATEROLE`. The API's login user is
created by the deployment as a member of `finance_api`.
