-- Admin quant performance log read access and operational event logging.
-- Adds no tables; preserves planned schema and RLS invariants (U1, D25).

GRANT SELECT ON model_results, winners, bond_etf_list, job_events TO finance_api;
GRANT INSERT ON job_events TO finance_api, finance_cycle, finance_executor;
GRANT USAGE, SELECT ON SEQUENCE job_events_id_seq TO finance_api, finance_cycle, finance_executor;
