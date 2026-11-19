-- Shared tables (U1): the same rows for every user.
-- No runtime role is granted anything here. Each later unit grants what it reads and writes.

CREATE TABLE assets (
    asset_class text NOT NULL CHECK (asset_class IN ('us_equity', 'crypto')),
    symbol text NOT NULL,
    status text NOT NULL,
    tradable boolean NOT NULL,
    fractionable boolean NOT NULL,
    exchange text,
    fetched_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (asset_class, symbol)
);

-- A dated, versioned watchlist that we own (D23).
CREATE TABLE bond_etf_list (
    version integer NOT NULL,
    symbol text NOT NULL,
    effective_on date NOT NULL,
    PRIMARY KEY (version, symbol)
);

-- One row per policy version, holding both modes' settings (D22). A row is never edited.
CREATE TABLE mode_policies (
    version integer PRIMARY KEY,
    policy jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- One cycle per date. It pins the identities its units, results and runs carry (D27, I4).
CREATE TABLE cycles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    cycle_date date NOT NULL UNIQUE,
    model_set_version text NOT NULL,
    policy_version integer NOT NULL REFERENCES mode_policies (version),
    costs jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE screening_figures (
    cycle_id uuid NOT NULL REFERENCES cycles (id),
    sector text NOT NULL CHECK (sector IN ('stock', 'bond', 'crypto')),
    symbol text NOT NULL,
    mean_dollar_volume numeric NOT NULL,
    mean_abs_move numeric,
    PRIMARY KEY (cycle_id, sector, symbol)
);

CREATE TABLE selections (
    cycle_id uuid NOT NULL,
    sector text NOT NULL,
    symbol text NOT NULL,
    PRIMARY KEY (cycle_id, sector, symbol),
    FOREIGN KEY (cycle_id, sector, symbol) REFERENCES screening_figures (cycle_id, sector, symbol)
);

CREATE TABLE selected_bars (
    cycle_id uuid NOT NULL REFERENCES cycles (id),
    symbol text NOT NULL,
    bar_date date NOT NULL,
    open numeric NOT NULL,
    high numeric NOT NULL,
    low numeric NOT NULL,
    close numeric NOT NULL,
    volume numeric NOT NULL,
    PRIMARY KEY (cycle_id, symbol, bar_date)
);

CREATE TABLE worker_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash bytea NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz
);

-- One unit per selected ticker of a cycle. A claim is a lease that expires (U10).
CREATE TABLE work_units (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    cycle_id uuid NOT NULL REFERENCES cycles (id),
    symbol text NOT NULL,
    leased_to uuid REFERENCES worker_tokens (id),
    lease_expires_at timestamptz,
    UNIQUE (cycle_id, symbol)
);

CREATE TABLE model_results (
    cycle_id uuid NOT NULL REFERENCES cycles (id),
    symbol text NOT NULL,
    model_id text NOT NULL,
    selection_net_return numeric NOT NULL,
    selection_sharpe numeric,  -- null when undefined (I7)
    selection_max_drawdown numeric NOT NULL,
    confirmation_net_return numeric NOT NULL,
    position numeric NOT NULL CHECK (position BETWEEN 0 AND 1),
    PRIMARY KEY (cycle_id, symbol, model_id)
);

CREATE TABLE winners (
    cycle_id uuid NOT NULL REFERENCES cycles (id),
    symbol text NOT NULL,
    mode text NOT NULL CHECK (mode IN ('stable', 'aggressive')),
    model_id text,  -- null when no winner is confirmed
    PRIMARY KEY (cycle_id, symbol, mode)
);

-- Static, dated tables that we own (D13).
CREATE TABLE rewards_rates (
    card_label text NOT NULL,
    category text NOT NULL,
    rate numeric NOT NULL,
    effective_on date NOT NULL,
    PRIMARY KEY (card_label, category, effective_on)
);

CREATE TABLE reference_rates (
    loan_kind text NOT NULL,
    rate numeric NOT NULL,
    effective_on date NOT NULL,
    PRIMARY KEY (loan_kind, effective_on)
);

CREATE TABLE job_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    source text NOT NULL,
    event text NOT NULL,
    detail jsonb NOT NULL DEFAULT '{}'
);
