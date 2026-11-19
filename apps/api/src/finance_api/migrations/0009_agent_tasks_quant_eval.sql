-- Allow 'quant_eval' in agent_tasks.kind for the HarnessRouter Cloud Quant Strategy Evaluator.
-- Adds no tables; preserves all U1 tables and forced row-level security policies.

ALTER TABLE agent_tasks
    DROP CONSTRAINT agent_tasks_kind_check,
    ADD CONSTRAINT agent_tasks_kind_check
        CHECK (kind IN ('advisor', 'search', 'quant_eval'));
