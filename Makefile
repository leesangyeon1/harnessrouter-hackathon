# The gate: every command below must exit 0 on the commit being merged.
# --all-packages installs every workspace member, so a new package joins without an edit here.
UV_RUN = uv run --all-packages

.PHONY: gate lint type test

gate: lint type test

lint:
	$(UV_RUN) ruff check .
	$(UV_RUN) ruff format --check .

type:
	$(UV_RUN) mypy

# Uses the PostgreSQL server at TEST_DATABASE_URL (a superuser URL) when it is set,
# and otherwise starts one for the session.
test:
	$(UV_RUN) pytest
