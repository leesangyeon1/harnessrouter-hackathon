-- HarnessRouter Cloud session, file metadata, and follow-up columns on tenant-isolated agent_tasks.
-- Adds no tables; preserves planned U1 schema and forced row-level security invariants.

ALTER TABLE agent_tasks
    ADD COLUMN session_id text,
    ADD COLUMN query_text text,
    ADD COLUMN parent_task_id uuid,
    ADD COLUMN files jsonb NOT NULL DEFAULT '[]',
    ADD COLUMN incomplete_reason text,
    ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
    ADD CONSTRAINT agent_tasks_parent_fk
        FOREIGN KEY (user_id, parent_task_id) REFERENCES agent_tasks (user_id, id);
