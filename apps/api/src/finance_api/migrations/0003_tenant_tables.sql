-- Tenant tables (U1). One user is one tenant; user_id is the Identity Platform uid.
-- A child names its parent by (user_id, id): a foreign key is checked without row-level
-- security, so the tenant has to be part of the key.

-- Roles live here and are read at request time (D25). No row means the role is 'user'.
CREATE TABLE user_roles (
    user_id text PRIMARY KEY,
    role text NOT NULL CHECK (role IN ('user', 'admin'))
);

CREATE TABLE plaid_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id text NOT NULL,
    plaid_item_id text NOT NULL,
    access_token_enc bytea NOT NULL,
    transactions_cursor text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, id),
    UNIQUE (user_id, plaid_item_id)
);

CREATE TABLE plaid_accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id text NOT NULL,
    item_id uuid NOT NULL,
    plaid_account_id text NOT NULL,
    name text,
    type text NOT NULL,
    subtype text,
    current_balance numeric,
    iso_currency_code text,
    UNIQUE (user_id, id),
    UNIQUE (user_id, plaid_account_id),
    FOREIGN KEY (user_id, item_id) REFERENCES plaid_items (user_id, id)
);

CREATE TABLE plaid_transactions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id text NOT NULL,
    account_id uuid NOT NULL,
    plaid_transaction_id text NOT NULL,
    posted_on date NOT NULL,
    amount numeric NOT NULL,
    name text,
    personal_finance_category text,  -- null when Plaid sent none (F8)
    UNIQUE (user_id, plaid_transaction_id),
    FOREIGN KEY (user_id, account_id) REFERENCES plaid_accounts (user_id, id)
);

CREATE TABLE plaid_liabilities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id text NOT NULL,
    account_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('credit', 'student', 'loan')),
    aprs jsonb,  -- credit only; an empty array means the APR is unknown, not 0% (I7)
    last_statement_balance numeric,
    minimum_payment_amount numeric,
    next_payment_due_on date,
    interest_rate numeric,
    principal_balance numeric,
    loan_term_months integer,
    maturity_on date,
    UNIQUE (user_id, account_id),
    FOREIGN KEY (user_id, account_id) REFERENCES plaid_accounts (user_id, id)
);

CREATE TABLE plaid_holdings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id text NOT NULL,
    account_id uuid NOT NULL,
    security_id text NOT NULL,
    ticker text,
    quantity numeric NOT NULL,
    institution_value numeric NOT NULL,
    UNIQUE (user_id, account_id, security_id),
    FOREIGN KEY (user_id, account_id) REFERENCES plaid_accounts (user_id, id)
);

CREATE TABLE reports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('spending', 'cards', 'refinance')),
    figures jsonb NOT NULL,
    computed_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, id)
);

-- The ledger row is written before the call is sent, and no call lacks a cap or a timeout (I9).
CREATE TABLE agent_tasks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('advisor', 'search')),
    idempotency_key text NOT NULL UNIQUE,
    cost_cap_usd numeric NOT NULL,
    timeout_seconds integer NOT NULL,
    harness_task_id text,
    status text NOT NULL,
    report_id uuid,
    cycle_id uuid REFERENCES cycles (id),
    result_text text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, id),
    FOREIGN KEY (user_id, report_id) REFERENCES reports (user_id, id)
);

-- The cap is reserved against the user's day before the call and settled after it (D17).
CREATE TABLE agent_spend (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id text NOT NULL,
    task_id uuid NOT NULL UNIQUE,
    spend_day date NOT NULL,
    reserved_usd numeric NOT NULL,
    settled_usd numeric,
    FOREIGN KEY (user_id, task_id) REFERENCES agent_tasks (user_id, id)
);

CREATE TABLE broker_links (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id text NOT NULL,
    paper_key_enc bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, id)
);

-- Each portfolio has its own dedicated paper account (D21).
CREATE TABLE portfolios (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id text NOT NULL,
    broker_link_id uuid NOT NULL UNIQUE,
    state text NOT NULL DEFAULT 'inactive' CHECK (state IN ('inactive', 'active', 'paused')),
    mode text NOT NULL CHECK (mode IN ('stable', 'aggressive')),
    cap_c0 numeric,
    activation_equity numeric,
    activated_at timestamptz,
    UNIQUE (user_id, id),
    FOREIGN KEY (user_id, broker_link_id) REFERENCES broker_links (user_id, id)
);

-- One run per portfolio and cycle. Mode and plans are written once (D26, I15).
CREATE TABLE runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id text NOT NULL,
    portfolio_id uuid NOT NULL,
    cycle_id uuid NOT NULL REFERENCES cycles (id),
    mode text NOT NULL CHECK (mode IN ('stable', 'aggressive')),
    step text NOT NULL,
    sell_plan jsonb,
    buy_plan jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, id),
    UNIQUE (portfolio_id, cycle_id),
    FOREIGN KEY (user_id, portfolio_id) REFERENCES portfolios (user_id, id)
);

CREATE TABLE targets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id text NOT NULL,
    run_id uuid NOT NULL,
    symbol text NOT NULL,
    targets_row smallint NOT NULL CHECK (targets_row BETWEEN 1 AND 6),
    target_value numeric,
    UNIQUE (run_id, symbol),
    FOREIGN KEY (user_id, run_id) REFERENCES runs (user_id, id)
);

-- One order per run, symbol and side (I5). Written as 'intent' before its submit (D26).
CREATE TABLE orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id text NOT NULL,
    run_id uuid NOT NULL,
    symbol text NOT NULL,
    side text NOT NULL CHECK (side IN ('S', 'B')),
    client_order_id text NOT NULL UNIQUE,
    state text NOT NULL CHECK (state IN (
        'intent', 'sent', 'unknown', 'filled', 'canceled', 'expired', 'rejected', 'not_placed'
    )),
    broker_order_id text,
    quantity numeric,
    notional numeric,
    reject_reason text,
    unknown_since timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, id),
    UNIQUE (run_id, symbol, side),
    FOREIGN KEY (user_id, run_id) REFERENCES runs (user_id, id)
);

-- What the broker's closing report said. Never a simulated price (I11).
CREATE TABLE fills (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id text NOT NULL,
    order_id uuid NOT NULL UNIQUE,
    filled_qty numeric NOT NULL,
    filled_avg_price numeric NOT NULL,
    filled_at timestamptz NOT NULL,
    FOREIGN KEY (user_id, order_id) REFERENCES orders (user_id, id)
);

-- Row-level security, forced, so the table owner is bound as well (I8). The one policy admits
-- the rows of the tenant set for the transaction; with none set it admits nothing.
DO $$
DECLARE
    table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'user_roles', 'plaid_items', 'plaid_accounts', 'plaid_transactions', 'plaid_liabilities',
        'plaid_holdings', 'reports', 'agent_tasks', 'agent_spend', 'broker_links', 'portfolios',
        'runs', 'targets', 'orders', 'fills'
    ] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I'
            ' USING (user_id = nullif(current_setting(''app.user_id'', true), ''''))'
            ' WITH CHECK (user_id = nullif(current_setting(''app.user_id'', true), ''''))',
            table_name
        );
        IF table_name = 'user_roles' THEN
            EXECUTE format('GRANT SELECT ON %I TO finance_api', table_name);
        ELSE
            EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO finance_api', table_name);
        END IF;
    END LOOP;
END
$$;
