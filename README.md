# harnessrouter-hackathon
Hackathon Project for harnessrouter.

A finance platform MVP: Plaid Sandbox reports, a daily screen of stocks, bond ETFs and crypto on
Alpaca data, ten quant models backtested on the owner's CPU nodes, and paper orders on Alpaca in
one of two modes. Sandbox and paper data only.

## Layout

| Path | What |
| --- | --- |
| `apps/api` | `finance_api`: the FastAPI service and the SQL migrations |
| `packages/*` | Libraries, each a uv workspace member |

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
  uv run --all-packages uvicorn finance_api.app:app_from_env --factory
```

The migrations create the roles `finance_api`, `finance_cycle` and `finance_executor` without a
login. The role that runs them owns every table and needs `CREATEROLE`. The API's login user is
created by the deployment as a member of `finance_api`.
