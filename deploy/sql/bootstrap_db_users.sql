-- Bootstrap Cloud SQL login roles and role memberships without granting table ownership
-- or BYPASSRLS to any runtime user.
--
-- Execution order on a new Cloud SQL instance:
--   1. Terraform creates Cloud SQL users:
--        - finance_migrator     (schema owner & migration runner)
--        - finance_api_app      (FastAPI & private Cloud Tasks worker login)
--        - finance_cycle_app    (market-ingest job login)
--        - finance_executor_app (paper-order job login)
--   2. Connect once as `postgres` (Cloud SQL built-in admin) to grant CREATEROLE and database
--      ownership to `finance_migrator` (Step A below).
--   3. Run `python -m finance_api.migrate` as `finance_migrator` (creates NOLOGIN roles
--      `finance_api`, `finance_cycle`, `finance_executor` and all tables with FORCE RLS).
--   4. Connect once as `postgres` (or `finance_migrator`) to grant NOLOGIN group roles to the
--      three runtime login users and verify NOBYPASSRLS / NOSUPERUSER (Step B below).

-- === Step A: Run BEFORE first `python -m finance_api.migrate` (as `postgres`) ===
ALTER ROLE finance_migrator CREATEROLE NOSUPERUSER NOBYPASSRLS;
GRANT ALL PRIVILEGES ON DATABASE finance TO finance_migrator;
\connect finance
GRANT ALL ON SCHEMA public TO finance_migrator;

-- === Step B: Run AFTER first `python -m finance_api.migrate` ===
ALTER ROLE finance_api_app NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
ALTER ROLE finance_cycle_app NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
ALTER ROLE finance_executor_app NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;

GRANT finance_api TO finance_api_app;
GRANT finance_cycle TO finance_cycle_app;
GRANT finance_executor TO finance_executor_app;

-- Sanity check query (must return 0 rows):
SELECT rolname, rolsuper, rolbypassrls
FROM pg_roles
WHERE rolname IN ('finance_api_app', 'finance_cycle_app', 'finance_executor_app',
                  'finance_api', 'finance_cycle', 'finance_executor')
  AND (rolsuper OR rolbypassrls);
