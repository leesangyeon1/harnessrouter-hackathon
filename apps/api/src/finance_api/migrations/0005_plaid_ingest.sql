-- Plaid ingest (U2).

-- The MVP seeds one custom-user Item per user. A second would count every balance twice.
CREATE UNIQUE INDEX plaid_items_one_per_user ON plaid_items (user_id);

-- A pending transaction is stored and left out of the spending report.
ALTER TABLE plaid_transactions ADD COLUMN pending boolean NOT NULL DEFAULT false;
