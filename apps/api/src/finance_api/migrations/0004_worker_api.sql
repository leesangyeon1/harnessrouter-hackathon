-- Worker API (U10).

-- A unit is done once its result is stored. A result is accepted once per cycle and ticker (I14).
ALTER TABLE work_units ADD COLUMN completed_at timestamptz;

-- A node computes under the stored policy and names its version, so the stored policy has to
-- name the version its row is filed under.
ALTER TABLE mode_policies ADD CONSTRAINT policy_names_its_version
    CHECK ((policy ->> 'version')::integer IS NOT DISTINCT FROM version);

-- What the API reads and writes for the three worker endpoints and the admin action.
GRANT SELECT, INSERT, UPDATE ON worker_tokens TO finance_api;
GRANT SELECT, UPDATE ON work_units TO finance_api;
GRANT SELECT ON cycles, mode_policies, selections, selected_bars TO finance_api;
GRANT INSERT ON model_results, winners TO finance_api;
