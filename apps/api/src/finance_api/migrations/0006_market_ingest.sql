-- Market ingest and the sector screen (U5).

-- Per sector: the universe and feed the screen ran on, its coverage figures, and the
-- exclusions the plan says to name (D23, I12).
ALTER TABLE cycles ADD COLUMN screens jsonb NOT NULL DEFAULT '{}';

-- The bond ETF watchlist, version 1 (D23). A watchlist that we own, not the set of bond ETFs.
INSERT INTO bond_etf_list (version, symbol, effective_on)
SELECT 1, symbol, DATE '2026-11-18'
FROM unnest(ARRAY['TLT', 'IEF', 'SHY', 'LQD', 'HYG', 'BND', 'TIP']) AS symbol;

-- Mode policy version 1: the numbers of D22. A new value is a new row, never an edit.
INSERT INTO mode_policies (version, policy)
VALUES (1, '{
    "version": 1,
    "stable_max_drawdown": 0.2,
    "stable_deploy": 0.5,
    "stable_ticker_cap": 0.2,
    "aggressive_deploy": 1.0,
    "aggressive_ticker_cap": 1.0,
    "confirmation_bars": 60
}');

-- What the cycle job reads and writes in this step.
GRANT SELECT, INSERT, DELETE ON assets TO finance_cycle;
GRANT SELECT ON bond_etf_list, mode_policies TO finance_cycle;
GRANT SELECT, INSERT ON cycles, screening_figures, selections, selected_bars, work_units
    TO finance_cycle;

-- The API serves the stored screen.
GRANT SELECT ON screening_figures TO finance_api;
