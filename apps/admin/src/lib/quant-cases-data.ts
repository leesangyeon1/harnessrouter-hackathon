export type QuantLegDetail = {
  legIndex: number;
  quantRankInCase: number;
  quantId: string;
  quantName: string;
  family:
    | "Trend"
    | "Mean Reversion"
    | "Momentum"
    | "Breakout"
    | "Statistical"
    | "Regime";
  algorithmFormula: string;
  parametersSummary: string;
  ticker: string;
  assetName: string;
  sector: "stock" | "bond" | "crypto";
  signal: "LONG" | "OVERWEIGHT" | "PULLBACK_LONG" | "BREAKOUT_LONG";
  quantOutcome: "WIN" | "LOSS";
  weightPct: number;
  notionalUsd: number;
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  entryTimeUtc: string;
  exitTimeUtc: string;
  computeMs: number;
  barsEvaluated: number;
  barHitRatePct: number;
  selectionSharpe: number;
  realizedSortino: number;
  maxDrawdownPct: number;
  confirmationReturnPct: number;
  grossReturnPct: number;
  grossPnlUsd: number;
  feeBps: number;
  feeUsd: number;
  netPnlUsd: number;
  netReturnPct: number;
};

export type QuantPerformanceCase = {
  caseNumber: number;
  caseId: string;
  cycleId: string;
  cycleDate: string;
  regimeNote: string;
  mode: "Stable" | "Aggressive";
  policyVersion: number;
  modelSetVersion: string;
  outcome: "PROFIT" | "LOSS";
  startedAtUtc: string;
  completedAtUtc: string;
  totalComputeSec: number;
  workerCluster: string;
  barsHashPrefix: string;
  policyHashPrefix: string;
  costsHashPrefix: string;
  startingCapitalUsd: number;
  deployedCapitalUsd: number;
  endingCapitalUsd: number;
  totalGrossPnlUsd: number;
  totalFeesUsd: number;
  netPnlUsd: number;
  netReturnPct: number;
  portfolioSharpe: number;
  sortinoRatio: number;
  maxDrawdownPct: number;
  winningLegsCount: number;
  losingLegsCount: number;
  totalLegsCount: number;
  legWinRatePct: number;
  quantsUsedSummary: string;
  bestQuantId: string;
  bestQuantName: string;
  bestQuantTicker: string;
  bestQuantNetPnlUsd: number;
  bestQuantNetReturnPct: number;
  worstQuantId: string;
  worstQuantName: string;
  worstQuantTicker: string;
  worstQuantNetPnlUsd: number;
  worstQuantNetReturnPct: number;
  legs: QuantLegDetail[];
};

export type QuantModelAggregateRow = {
  quantId: string;
  quantName: string;
  family: QuantLegDetail["family"];
  algorithmFormula: string;
  parametersSummary: string;
  casesUsedCount: number;
  winningRunsCount: number;
  losingRunsCount: number;
  winRatePct: number;
  totalGrossPnlUsd: number;
  totalFeesUsd: number;
  totalNetPnlUsd: number;
  meanNetReturnPct: number;
  meanSharpe: number;
  worstMaxDrawdownPct: number;
  bestCaseId: string;
  bestCaseNetPnlUsd: number;
  worstCaseId: string;
  worstCaseNetPnlUsd: number;
};

export const QUANT_CATALOG: {
  id: string;
  name: string;
  family: QuantLegDetail["family"];
  formula: string;
  params: string;
}[] = [
  {
    id: "M01",
    name: "SMA 20/50 Golden Trend",
    family: "Trend",
    formula: "pos_t = 1[SMA(C,20) > SMA(C,50)] · stop = 2.5×ATR(14)",
    params: "fast=20d, slow=50d, atr_stop=2.5",
  },
  {
    id: "M02",
    name: "EMA 12/26 Momentum Cross",
    family: "Trend",
    formula: "pos_t = 1[EMA(C,12) > EMA(C,26)] · trail = 2.0×ATR(14)",
    params: "ema_fast=12d, ema_slow=26d, trail=2.0",
  },
  {
    id: "M03",
    name: "MACD 12/26/9 Histogram Impulse",
    family: "Momentum",
    formula: "pos_t = 1[MACD_hist(12,26,9) > 0 ∧ Δhist_t > 0]",
    params: "fast=12, slow=26, sig=9, hold=5d",
  },
  {
    id: "M04",
    name: "RSI-14 Oversold Reversion",
    family: "Mean Reversion",
    formula: "entry: RSI(14) < 30 · exit: RSI(14) > 55",
    params: "rsi_len=14, buy_th=30, exit_th=55",
  },
  {
    id: "M05",
    name: "Bollinger 2.0σ Band Reversion",
    family: "Mean Reversion",
    formula: "entry: C_t < SMA(20) − 2.0σ(20) · exit: C_t ≥ SMA(20)",
    params: "window=20d, band_k=2.0σ",
  },
  {
    id: "M06",
    name: "Donchian 20/10 Channel Breakout",
    family: "Breakout",
    formula: "entry: C_t > max(H_{t-20..t-1}) · exit: C_t < min(L_{t-10..t-1})",
    params: "entry_hi=20d, exit_lo=10d",
  },
  {
    id: "M07",
    name: "60-Day Time-Series Momentum",
    family: "Momentum",
    formula: "pos_t = 1[(C_{t-1}/C_{t-61} − 1) / σ_60d > 0.50]",
    params: "lookback=60d, ir_gate=0.50",
  },
  {
    id: "M08",
    name: "Volatility-Scaled Momentum (10% Vol)",
    family: "Momentum",
    formula: "w_t = min(1.0, 0.10 / σ_EWMA(20d)) × 1[Ret_40d > 0]",
    params: "target_vol=10%, ewma=20d, mom=40d",
  },
  {
    id: "M09",
    name: "Keltner ATR-14 Channel Breakout",
    family: "Breakout",
    formula: "entry: C_t > EMA(20) + 1.75×ATR(14) ∧ ADX(14) > 20",
    params: "ema=20d, atr_mult=1.75, adx_min=20",
  },
  {
    id: "M10",
    name: "Stochastic %K/%D Reversion",
    family: "Mean Reversion",
    formula: "entry: %K(14,3) crosses %D(3) < 20 · exit: %K > 75",
    params: "k_len=14, smooth=3, d_len=3",
  },
  {
    id: "M11",
    name: "5-Day Short-Term Reversal",
    family: "Mean Reversion",
    formula: "pos_t = 1[−Z_60d(Ret_5d) > 1.50] · 3-bar decay",
    params: "ret_win=5d, z_norm=60d, z_th=1.50",
  },
  {
    id: "M12",
    name: "Kalman Filter Adaptive Trend",
    family: "Statistical",
    formula: "pos_t = 1[(x̂_t − x̂_{t-1}) / √P_t > 1.15] (Q=1e-4, R=1e-2)",
    params: "process_Q=1e-4, meas_R=1e-2, z=1.15",
  },
  {
    id: "M13",
    name: "Ornstein-Uhlenbeck Z-Score Arb",
    family: "Statistical",
    formula: "dX=θ(μ−X)dt+σdW · entry: s_score < −1.75 (t_1/2 ≤ 12d)",
    params: "s_entry=-1.75, s_exit=-0.25, max_hl=12d",
  },
  {
    id: "M14",
    name: "VWAP Institutional Drift",
    family: "Trend",
    formula: "pos_t = 1[(C_t − VWAP_20d) / σ_VWAP > 0.80 ∧ RVOL ≥ 1.2]",
    params: "vwap_win=20d, dev_z=0.80, rvol=1.2",
  },
  {
    id: "M15",
    name: "OBV Volume-Confirmed Breakout",
    family: "Breakout",
    formula: "pos_t = 1[OBV_t > max(OBV,20) ∧ C_t > max(H,15)]",
    params: "obv_hi=20d, price_hi=15d",
  },
  {
    id: "M16",
    name: "Chaikin Money Flow Accumulation",
    family: "Momentum",
    formula: "pos_t = 1[CMF(20) > +0.15 ∧ C_t > EMA(C,30)]",
    params: "cmf_win=20d, cmf_th=0.15, ema=30d",
  },
  {
    id: "M17",
    name: "ATR Chandelier Trailing Trend",
    family: "Trend",
    formula: "pos_t = 1[C_t > max(H,22) − 3.0×ATR(22)]",
    params: "lookback=22d, chandelier_k=3.0",
  },
  {
    id: "M18",
    name: "Cross-Sectional Relative Strength",
    family: "Momentum",
    formula: "pos_t = 1[PctRank(Ret_{t-90→t-5}) ≥ 0.85]",
    params: "rs_win=90d, skip=5d, top_pct=15%",
  },
  {
    id: "M19",
    name: "Hurst Exponent Regime Filter",
    family: "Regime",
    formula: "H(100d) > 0.56 ⇒ momentum(20d); H < 0.44 ⇒ z-revert(10d)",
    params: "rs_bars=100d, h_trend=0.56, h_rev=0.44",
  },
  {
    id: "M20",
    name: "Hidden Markov Volatility Switch",
    family: "Regime",
    formula: "pos_t = 1[P(State_t = LowVolBull | r_{1..t}) > 0.72]",
    params: "states=2, em_win=120d, prob_th=0.72",
  },
  {
    id: "M21",
    name: "Connors RSI-2 Pullback",
    family: "Mean Reversion",
    formula: "entry: RSI(2) < 10 ∧ C_t > SMA(200) · exit: C_t > SMA(5)",
    params: "rsi_len=2, trend_sma=200d, exit_sma=5d",
  },
  {
    id: "M22",
    name: "Garman-Klass Range Vol Alpha",
    family: "Statistical",
    formula: "pos_t = 1[σ_GK(10)/σ_GK(60) < 0.85 ∧ EMA(10) > EMA(30)]",
    params: "gk_short=10d, gk_long=60d, ratio=0.85",
  },
  {
    id: "M23",
    name: "ADX-25 Directional Trend",
    family: "Trend",
    formula: "pos_t = 1[ADX(14) > 25 ∧ +DI(14) > −DI(14)]",
    params: "di_len=14, adx_min=25",
  },
  {
    id: "M24",
    name: "Sharpe-Weighted Horizon Ensemble",
    family: "Regime",
    formula: "S_t = Σ_{h∈{5,20,60}} max(0, SR_h) · sig_h(t) / Σ SR_h",
    params: "horizons=5/20/60d, gate=0.55",
  },
];

const TICKER_CATALOG: {
  ticker: string;
  name: string;
  sector: "stock" | "bond" | "crypto";
  basePrice: number;
}[] = [
  { ticker: "NVDA", name: "NVIDIA Corp.", sector: "stock", basePrice: 138.4 },
  { ticker: "AAPL", name: "Apple Inc.", sector: "stock", basePrice: 226.8 },
  { ticker: "MSFT", name: "Microsoft Corp.", sector: "stock", basePrice: 418.5 },
  { ticker: "AMZN", name: "Amazon.com Inc.", sector: "stock", basePrice: 204.2 },
  { ticker: "GOOGL", name: "Alphabet Inc.", sector: "stock", basePrice: 179.6 },
  { ticker: "META", name: "Meta Platforms Inc.", sector: "stock", basePrice: 582.0 },
  { ticker: "TSLA", name: "Tesla Inc.", sector: "stock", basePrice: 318.5 },
  { ticker: "AMD", name: "Advanced Micro Devices", sector: "stock", basePrice: 146.2 },
  { ticker: "AVGO", name: "Broadcom Inc.", sector: "stock", basePrice: 174.9 },
  { ticker: "JPM", name: "JPMorgan Chase & Co.", sector: "stock", basePrice: 239.4 },
  { ticker: "GS", name: "Goldman Sachs Group", sector: "stock", basePrice: 588.0 },
  { ticker: "LLY", name: "Eli Lilly & Co.", sector: "stock", basePrice: 814.0 },
  { ticker: "UNH", name: "UnitedHealth Group", sector: "stock", basePrice: 592.5 },
  { ticker: "V", name: "Visa Inc.", sector: "stock", basePrice: 308.4 },
  { ticker: "COST", name: "Costco Wholesale", sector: "stock", basePrice: 924.0 },
  { ticker: "XOM", name: "Exxon Mobil Corp.", sector: "stock", basePrice: 118.7 },
  { ticker: "TLT", name: "iShares 20+ Yr Treasury Bond ETF", sector: "bond", basePrice: 91.4 },
  { ticker: "IEF", name: "iShares 7-10 Yr Treasury Bond ETF", sector: "bond", basePrice: 94.2 },
  { ticker: "SHY", name: "iShares 1-3 Yr Treasury Bond ETF", sector: "bond", basePrice: 82.15 },
  { ticker: "LQD", name: "iShares iBoxx Inv Grade Corp Bond", sector: "bond", basePrice: 108.6 },
  { ticker: "HYG", name: "iShares iBoxx High Yield Corp Bond", sector: "bond", basePrice: 79.35 },
  { ticker: "BND", name: "Vanguard Total Bond Market ETF", sector: "bond", basePrice: 72.8 },
  { ticker: "BTC/USD", name: "Bitcoin / US Dollar", sector: "crypto", basePrice: 88450.0 },
  { ticker: "ETH/USD", name: "Ethereum / US Dollar", sector: "crypto", basePrice: 3185.0 },
  { ticker: "SOL/USD", name: "Solana / US Dollar", sector: "crypto", basePrice: 212.4 },
];

// 30 hardcoded evaluation cases: EXACTLY 21 LOSS (70.0%) and 9 WINNING/PROFIT (30.0%).
const CASE_SPECS: {
  date: string;
  profitable: boolean;
  mode: "Stable" | "Aggressive";
  biasBps: number;
  regimeNote: string;
}[] = [
  { date: "2026-11-19", profitable: false, mode: "Aggressive", biasBps: -235, regimeNote: "High-beta momentum reversal & crypto basis squeeze dragging breakout quants" },
  { date: "2026-11-18", profitable: true, mode: "Stable", biasBps: 184, regimeNote: "Treasury yield stabilization + clean Kalman & OU mean-reversion capture" },
  { date: "2026-11-17", profitable: false, mode: "Aggressive", biasBps: -278, regimeNote: "Post-open semiconductor bull-trap fade triggering ATR & Donchian stops" },
  { date: "2026-11-14", profitable: false, mode: "Stable", biasBps: -152, regimeNote: "Intraday rate-shock whip-saw across TLT/IEF and growth equities" },
  { date: "2026-11-13", profitable: true, mode: "Aggressive", biasBps: 292, regimeNote: "Broad mega-cap & BTC/USD trend continuation across M01, M07, and M12" },
  { date: "2026-11-12", profitable: false, mode: "Aggressive", biasBps: -214, regimeNote: "CPI print two-way volatility whipsawing EMA 12/26 and Keltner channels" },
  { date: "2026-11-11", profitable: false, mode: "Stable", biasBps: -138, regimeNote: "Choppy mean-reverting range with elevated turnover & fee drag" },
  { date: "2026-11-10", profitable: true, mode: "Stable", biasBps: 168, regimeNote: "Low-volatility defensive drift led by VWAP, Hurst, and Sharpe ensemble" },
  { date: "2026-11-09", profitable: false, mode: "Aggressive", biasBps: -312, regimeNote: "Weekend crypto gap-up reversal & high-multiple tech de-grossing" },
  { date: "2026-11-06", profitable: false, mode: "Stable", biasBps: -164, regimeNote: "30-year Treasury auction tail pressuring duration & equity trend legs" },
  { date: "2026-11-05", profitable: true, mode: "Aggressive", biasBps: 318, regimeNote: "Strong post-earnings dispersion captured by Cross-Sectional RS & MACD" },
  { date: "2026-11-04", profitable: false, mode: "Stable", biasBps: -126, regimeNote: "False oversold bounce in RSI-14 & Stochastic reversion models" },
  { date: "2026-11-03", profitable: false, mode: "Aggressive", biasBps: -248, regimeNote: "Cross-asset correlation spike breaking statistical arbitrage pairs" },
  { date: "2026-10-30", profitable: true, mode: "Stable", biasBps: 176, regimeNote: "Month-end institutional VWAP & Chaikin Money Flow accumulation" },
  { date: "2026-10-29", profitable: false, mode: "Aggressive", biasBps: -265, regimeNote: "Cloud capex guidance shock hitting NVDA, AVGO, AMD momentum legs" },
  { date: "2026-10-28", profitable: false, mode: "Stable", biasBps: -144, regimeNote: "Mid-session liquidity vacuum reversing morning breakout entries" },
  { date: "2026-10-27", profitable: true, mode: "Aggressive", biasBps: 268, regimeNote: "High-conviction breakout follow-through across equities & SOL/USD" },
  { date: "2026-10-24", profitable: false, mode: "Aggressive", biasBps: -288, regimeNote: "Late-Friday crowded momentum unwind across mega-cap & crypto USD pairs" },
  { date: "2026-10-23", profitable: false, mode: "Stable", biasBps: -134, regimeNote: "Narrow leadership dispersion causing 16 of 22 quant legs to slip negative" },
  { date: "2026-10-22", profitable: true, mode: "Stable", biasBps: 194, regimeNote: "Clean Bollinger 2.0σ & Connors RSI-2 oversold snapback" },
  { date: "2026-10-21", profitable: false, mode: "Aggressive", biasBps: -224, regimeNote: "Macro headline reversal breaking 20-day Donchian & OBV breakouts" },
  { date: "2026-10-20", profitable: false, mode: "Stable", biasBps: -158, regimeNote: "Credit spread widening across HYG/LQD & financials trend models" },
  { date: "2026-10-16", profitable: true, mode: "Aggressive", biasBps: 304, regimeNote: "Synchronized multi-sector rally with 18/22 quants finishing net positive" },
  { date: "2026-10-15", profitable: false, mode: "Aggressive", biasBps: -296, regimeNote: "Semiconductor export-control gap-down overwhelming mean-reversion bids" },
  { date: "2026-10-14", profitable: false, mode: "Stable", biasBps: -149, regimeNote: "Curve bear-steepening hurting bond ETFs & low-vol trend quants" },
  { date: "2026-10-13", profitable: false, mode: "Aggressive", biasBps: -208, regimeNote: "High-frequency intraday chop eroding Chandelier & ADX-25 entries" },
  { date: "2026-10-10", profitable: true, mode: "Stable", biasBps: 212, regimeNote: "Disciplined HMM low-vol regime filter + Kalman adaptive trend win" },
  { date: "2026-10-09", profitable: false, mode: "Aggressive", biasBps: -254, regimeNote: "Pre-CPI de-risking across BTC/USD, ETH/USD, and high-beta tech" },
  { date: "2026-10-08", profitable: false, mode: "Stable", biasBps: -172, regimeNote: "Energy shock & dollar surge dragging broad multi-asset trend signals" },
  { date: "2026-10-07", profitable: false, mode: "Aggressive", biasBps: -238, regimeNote: "Failed morning gap continuation across 17 of 22 deployed quant models" },
];

const SIGNALS: QuantLegDetail["signal"][] = [
  "LONG",
  "OVERWEIGHT",
  "PULLBACK_LONG",
  "BREAKOUT_LONG",
];

function deterministicWave(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function hexDigestPrefix(seedLabel: string, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    const n = Math.floor(
      deterministicWave(seedLabel.charCodeAt(i % seedLabel.length) * (i + 7)) *
        16,
    );
    out += n.toString(16);
  }
  return out;
}

const LEGS_PER_CASE = 22;

function buildHardcodedCases(): QuantPerformanceCase[] {
  return CASE_SPECS.map((spec, cIdx) => {
    const caseNumber = cIdx + 1;
    const caseId = `QCASE-2026-${String(caseNumber).padStart(3, "0")}`;
    const cycleId = `${hexDigestPrefix(caseId + "-c", 8)}-4b2a-9c1e-${hexDigestPrefix(caseId + "-d", 12)}`;
    const startingCapitalUsd = 100_000;
    const deployedCapitalUsd = spec.mode === "Stable" ? 50_000 : 100_000;
    const policyVersion = spec.mode === "Stable" ? 1 : 2;
    const baseNotional =
      Math.round((deployedCapitalUsd / LEGS_PER_CASE) * 100) / 100;

    const startMin = 13 + (cIdx % 3);
    const startedAtUtc = `${spec.date}T${String(startMin).padStart(2, "0")}:30:04Z`;
    const totalComputeSec = Number(
      (18.4 + deterministicWave(cIdx + 3) * 24.5).toFixed(2),
    );
    const completedSec = 4 + Math.round(totalComputeSec);
    const completedAtUtc = `${spec.date}T${String(startMin).padStart(2, "0")}:30:${String(
      Math.min(59, completedSec),
    ).padStart(2, "0")}Z`;

    const legs: QuantLegDetail[] = [];
    let sumGrossPnlCents = 0;
    let sumNetPnlCents = 0;
    let sumFeesCents = 0;

    for (let lIdx = 0; lIdx < LEGS_PER_CASE; lIdx++) {
      // Pick 22 distinct quants and 22 distinct tickers per case
      const quant = QUANT_CATALOG[(cIdx + lIdx) % QUANT_CATALOG.length];
      const asset = TICKER_CATALOG[(cIdx * 2 + lIdx) % TICKER_CATALOG.length];
      const wave = deterministicWave((cIdx + 1) * 101 + (lIdx + 1) * 37);

      // Realistic per-quant dispersion around the case regime bias so even loss cases
      // have a few bright-spot quants and winning cases have a few lagging quants.
      const dispersion = (wave - 0.5) * 0.068; // -3.4% .. +3.4%
      const targetBias = spec.biasBps / 10_000;
      let targetReturn = targetBias + dispersion;
      if (spec.profitable) {
        targetReturn = Math.max(-0.022, Math.min(0.068, targetReturn));
      } else {
        targetReturn = Math.max(-0.068, Math.min(0.021, targetReturn));
      }

      const isLastLeg = lIdx === LEGS_PER_CASE - 1;
      const notionalUsd = isLastLeg
        ? Number(
            (deployedCapitalUsd - baseNotional * (LEGS_PER_CASE - 1)).toFixed(
              2,
            ),
          )
        : baseNotional;

      const feeBps = asset.sector === "crypto" ? 25 : asset.sector === "bond" ? 6 : 10;
      const roundTripFeeCents = Math.round(
        notionalUsd * (feeBps / 10_000) * 2 * 100,
      );
      const feeUsd = roundTripFeeCents / 100;

      // Ensure final case total strictly satisfies PROFIT (> +$450) or LOSS (< -$450)
      // BEFORE deriving exitPrice so price, gross P&L, fees, and net P&L reconcile cleanly.
      if (isLastLeg) {
        const prelimGrossCents = Math.round(notionalUsd * targetReturn * 100);
        const prelimNetCents = prelimGrossCents - roundTripFeeCents;
        const projectedCaseNetCents = sumNetPnlCents + prelimNetCents;
        if (spec.profitable && projectedCaseNetCents < 55_000) {
          const neededGrossCents =
            55_000 - sumNetPnlCents + roundTripFeeCents;
          targetReturn = neededGrossCents / (notionalUsd * 100);
        } else if (!spec.profitable && projectedCaseNetCents > -55_000) {
          const neededGrossCents =
            -55_000 - sumNetPnlCents + roundTripFeeCents;
          targetReturn = neededGrossCents / (notionalUsd * 100);
        }
      }

      const priceDrift = 1 + (cIdx - 15) * 0.0035;
      const entryPrice = Number((asset.basePrice * priceDrift).toFixed(4));
      const exitPrice = Number((entryPrice * (1 + targetReturn)).toFixed(4));
      const quantity = Number((notionalUsd / entryPrice).toFixed(4));

      const realizedGrossReturn = (exitPrice - entryPrice) / entryPrice;
      const grossPnlCents = Math.round(notionalUsd * realizedGrossReturn * 100);
      const netPnlCents = grossPnlCents - roundTripFeeCents;

      sumGrossPnlCents += grossPnlCents;
      sumFeesCents += roundTripFeeCents;
      sumNetPnlCents += netPnlCents;

      const grossPnlUsd = Number((grossPnlCents / 100).toFixed(2));
      const netPnlUsd = Number((netPnlCents / 100).toFixed(2));
      const grossReturnPct = Number((realizedGrossReturn * 100).toFixed(2));
      const netReturnPct = Number(((netPnlUsd / notionalUsd) * 100).toFixed(2));
      const quantWin = netPnlUsd > 0;

      const entryHour = 14 + (lIdx % 2);
      const entryMin = (lIdx * 2 + cIdx) % 55;
      const entryTimeUtc = `${spec.date}T${String(entryHour).padStart(2, "0")}:${String(
        entryMin,
      ).padStart(2, "0")}:12Z`;
      const exitTimeUtc = `${spec.date}T20:${String((entryMin + 4) % 60).padStart(2, "0")}:00Z`;

      legs.push({
        legIndex: lIdx + 1,
        quantRankInCase: 0, // populated after sorting below
        quantId: quant.id,
        quantName: quant.name,
        family: quant.family,
        algorithmFormula: quant.formula,
        parametersSummary: quant.params,
        ticker: asset.ticker,
        assetName: asset.name,
        sector: asset.sector,
        signal: SIGNALS[(cIdx + lIdx) % SIGNALS.length],
        quantOutcome: quantWin ? "WIN" : "LOSS",
        weightPct: Number(((notionalUsd / startingCapitalUsd) * 100).toFixed(2)),
        notionalUsd,
        quantity,
        entryPrice: Number(entryPrice.toFixed(2)),
        exitPrice: Number(exitPrice.toFixed(2)),
        entryTimeUtc,
        exitTimeUtc,
        computeMs: 420 + ((cIdx * 53 + lIdx * 79) % 1180),
        barsEvaluated: 320 + ((cIdx * 17 + lIdx * 13) % 181),
        barHitRatePct: Number(
          (
            (quantWin ? 54.5 : 41.2) +
            deterministicWave(cIdx * 31 + lIdx * 17) * 14.2
          ).toFixed(1),
        ),
        selectionSharpe: Number(
          (
            (quantWin ? 1.42 : -0.68) +
            (deterministicWave(cIdx * 19 + lIdx * 7) - 0.35) * 1.35
          ).toFixed(2),
        ),
        realizedSortino: Number(
          (
            (quantWin ? 1.95 : -0.92) +
            (deterministicWave(cIdx * 23 + lIdx * 11) - 0.35) * 1.55
          ).toFixed(2),
        ),
        maxDrawdownPct: Number(
          (
            (spec.mode === "Stable" ? 5.8 : 10.6) +
            (quantWin ? 0 : 3.4) +
            deterministicWave(cIdx * 11 + lIdx * 23) * 7.8
          ).toFixed(2),
        ),
        confirmationReturnPct: Number(
          (
            (quantWin ? 1.65 : -1.45) +
            (deterministicWave(cIdx * 29 + lIdx * 13) - 0.45) * 3.1
          ).toFixed(2),
        ),
        grossReturnPct,
        grossPnlUsd,
        feeBps,
        feeUsd,
        netPnlUsd,
        netReturnPct,
      });
    }

    // Assign quantRankInCase (1 = highest netPnlUsd, 22 = lowest netPnlUsd)
    const ranked = [...legs].sort(
      (a, b) => b.netPnlUsd - a.netPnlUsd || a.legIndex - b.legIndex,
    );
    ranked.forEach((leg, rankIdx) => {
      leg.quantRankInCase = rankIdx + 1;
    });

    const bestLeg = ranked[0];
    const worstLeg = ranked[ranked.length - 1];
    const winningLegsCount = legs.filter((l) => l.netPnlUsd > 0).length;
    const losingLegsCount = LEGS_PER_CASE - winningLegsCount;

    const firstQuantId = legs[0].quantId;
    const lastQuantId = legs[legs.length - 1].quantId;
    const quantsUsedSummary =
      cIdx % QUANT_CATALOG.length <= QUANT_CATALOG.length - LEGS_PER_CASE
        ? `${firstQuantId}–${lastQuantId} (22 quants)`
        : `${firstQuantId}–M24, M01–${lastQuantId} (22 quants)`;

    const totalGrossPnlUsd = Number((sumGrossPnlCents / 100).toFixed(2));
    const totalFeesUsd = Number((sumFeesCents / 100).toFixed(2));
    const netPnlUsd = Number((sumNetPnlCents / 100).toFixed(2));
    const endingCapitalUsd = Number(
      (startingCapitalUsd + netPnlUsd).toFixed(2),
    );
    const netReturnPct = Number(
      ((netPnlUsd / startingCapitalUsd) * 100).toFixed(2),
    );
    const legWinRatePct = Number(
      ((winningLegsCount / LEGS_PER_CASE) * 100).toFixed(1),
    );

    return {
      caseNumber,
      caseId,
      cycleId,
      cycleDate: spec.date,
      regimeNote: spec.regimeNote,
      mode: spec.mode,
      policyVersion,
      modelSetVersion: "daily-v1+ext24",
      outcome: netPnlUsd > 0 ? "PROFIT" : "LOSS",
      startedAtUtc,
      completedAtUtc,
      totalComputeSec,
      workerCluster: `cpu-pool-us-central1-node-0${(cIdx % 6) + 1}`,
      barsHashPrefix: hexDigestPrefix(caseId + "-bars", 16),
      policyHashPrefix: "46d1d390b461b8aa",
      costsHashPrefix: "9f1dc46638cbaa36",
      startingCapitalUsd,
      deployedCapitalUsd,
      endingCapitalUsd,
      totalGrossPnlUsd,
      totalFeesUsd,
      netPnlUsd,
      netReturnPct,
      portfolioSharpe: Number(
        (
          (spec.profitable ? 1.68 : -0.84) +
          (deterministicWave(cIdx + 41) - 0.4) * 0.85
        ).toFixed(2),
      ),
      sortinoRatio: Number(
        (
          (spec.profitable ? 2.24 : -1.12) +
          (deterministicWave(cIdx + 67) - 0.4) * 1.05
        ).toFixed(2),
      ),
      maxDrawdownPct: Number(
        (
          (spec.mode === "Stable" ? 5.2 : 10.4) +
          (spec.profitable ? 0 : 2.8) +
          deterministicWave(cIdx + 89) * 6.2
        ).toFixed(2),
      ),
      winningLegsCount,
      losingLegsCount,
      totalLegsCount: LEGS_PER_CASE,
      legWinRatePct,
      quantsUsedSummary,
      bestQuantId: bestLeg.quantId,
      bestQuantName: bestLeg.quantName,
      bestQuantTicker: bestLeg.ticker,
      bestQuantNetPnlUsd: bestLeg.netPnlUsd,
      bestQuantNetReturnPct: bestLeg.netReturnPct,
      worstQuantId: worstLeg.quantId,
      worstQuantName: worstLeg.quantName,
      worstQuantTicker: worstLeg.ticker,
      worstQuantNetPnlUsd: worstLeg.netPnlUsd,
      worstQuantNetReturnPct: worstLeg.netReturnPct,
      legs,
    };
  });
}

export const QUANT_PERFORMANCE_CASES: QuantPerformanceCase[] =
  buildHardcodedCases();

export const QUANT_MODEL_LEADERBOARD: QuantModelAggregateRow[] = QUANT_CATALOG.map(
  (q) => {
    const matching: { caseId: string; leg: QuantLegDetail }[] = [];
    for (const c of QUANT_PERFORMANCE_CASES) {
      for (const leg of c.legs) {
        if (leg.quantId === q.id) {
          matching.push({ caseId: c.caseId, leg });
        }
      }
    }
    const casesUsedCount = matching.length;
    const winningRunsCount = matching.filter(
      (m) => m.leg.netPnlUsd > 0,
    ).length;
    const losingRunsCount = casesUsedCount - winningRunsCount;
    const totalGrossPnlUsd = Number(
      matching.reduce((acc, m) => acc + m.leg.grossPnlUsd, 0).toFixed(2),
    );
    const totalFeesUsd = Number(
      matching.reduce((acc, m) => acc + m.leg.feeUsd, 0).toFixed(2),
    );
    const totalNetPnlUsd = Number(
      matching.reduce((acc, m) => acc + m.leg.netPnlUsd, 0).toFixed(2),
    );
    const meanNetReturnPct = Number(
      (
        matching.reduce((acc, m) => acc + m.leg.netReturnPct, 0) /
        Math.max(1, casesUsedCount)
      ).toFixed(2),
    );
    const meanSharpe = Number(
      (
        matching.reduce((acc, m) => acc + m.leg.selectionSharpe, 0) /
        Math.max(1, casesUsedCount)
      ).toFixed(2),
    );
    const worstMaxDrawdownPct = Number(
      Math.max(...matching.map((m) => m.leg.maxDrawdownPct)).toFixed(2),
    );
    const sortedByPnl = [...matching].sort(
      (a, b) => b.leg.netPnlUsd - a.leg.netPnlUsd,
    );
    const best = sortedByPnl[0];
    const worst = sortedByPnl[sortedByPnl.length - 1];
    return {
      quantId: q.id,
      quantName: q.name,
      family: q.family,
      algorithmFormula: q.formula,
      parametersSummary: q.params,
      casesUsedCount,
      winningRunsCount,
      losingRunsCount,
      winRatePct: Number(
        ((winningRunsCount / Math.max(1, casesUsedCount)) * 100).toFixed(1),
      ),
      totalGrossPnlUsd,
      totalFeesUsd,
      totalNetPnlUsd,
      meanNetReturnPct,
      meanSharpe,
      worstMaxDrawdownPct,
      bestCaseId: best ? best.caseId : "—",
      bestCaseNetPnlUsd: best ? best.leg.netPnlUsd : 0,
      worstCaseId: worst ? worst.caseId : "—",
      worstCaseNetPnlUsd: worst ? worst.leg.netPnlUsd : 0,
    };
  },
);

export const QUANT_BENCHMARK_SUMMARY = (() => {
  const totalCases = QUANT_PERFORMANCE_CASES.length;
  const profitCases = QUANT_PERFORMANCE_CASES.filter(
    (c) => c.outcome === "PROFIT",
  ).length;
  const lossCases = QUANT_PERFORMANCE_CASES.filter(
    (c) => c.outcome === "LOSS",
  ).length;
  const totalGrossPnlUsd = Number(
    QUANT_PERFORMANCE_CASES.reduce((acc, c) => acc + c.totalGrossPnlUsd, 0).toFixed(
      2,
    ),
  );
  const totalNetPnlUsd = Number(
    QUANT_PERFORMANCE_CASES.reduce((acc, c) => acc + c.netPnlUsd, 0).toFixed(2),
  );
  const totalFeesUsd = Number(
    QUANT_PERFORMANCE_CASES.reduce((acc, c) => acc + c.totalFeesUsd, 0).toFixed(
      2,
    ),
  );
  const totalLegExecutions = QUANT_PERFORMANCE_CASES.reduce(
    (acc, c) => acc + c.totalLegsCount,
    0,
  );
  const totalWinningQuantRuns = QUANT_PERFORMANCE_CASES.reduce(
    (acc, c) => acc + c.winningLegsCount,
    0,
  );
  const totalLosingQuantRuns = QUANT_PERFORMANCE_CASES.reduce(
    (acc, c) => acc + c.losingLegsCount,
    0,
  );
  const meanSharpe = Number(
    (
      QUANT_PERFORMANCE_CASES.reduce((acc, c) => acc + c.portfolioSharpe, 0) /
      totalCases
    ).toFixed(2),
  );
  return {
    totalCases,
    profitCases,
    lossCases,
    profitRatePct: Number(((profitCases / totalCases) * 100).toFixed(1)),
    lossRatePct: Number(((lossCases / totalCases) * 100).toFixed(1)),
    totalGrossPnlUsd,
    totalNetPnlUsd,
    totalFeesUsd,
    totalLegExecutions,
    totalWinningQuantRuns,
    totalLosingQuantRuns,
    distinctQuantsCatalogCount: QUANT_CATALOG.length,
    meanSharpe,
  };
})();
