-- Runtime roles (D25). The role that runs the migrations owns every table; these three own none.
-- The deployment creates the login users and makes each a member of one of them.
-- Roles are cluster-wide, so a second database on the same server finds them present.
DO $$
DECLARE
    role_name text;
BEGIN
    FOREACH role_name IN ARRAY ARRAY['finance_api', 'finance_cycle', 'finance_executor'] LOOP
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = role_name) THEN
            EXECUTE format(
                'CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB',
                role_name
            );
        END IF;
    END LOOP;
END
$$;
