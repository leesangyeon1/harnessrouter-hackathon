export type PayoffSimulation = {
  payable: boolean;
  months: number | null;
  upfrontFeeUsd: string;
  totalInterestUsd: string;
  totalCostUsd: string;
  remainingAtPromoEndUsd?: string;
};

export type BalanceTransferScenario = {
  balanceUsd: number;
  currentAprPct: number;
  monthlyPaymentUsd: number;
  transferFeePct: number;
  promoAprPct: number;
  promoMonths: number;
  postPromoAprPct: number;
  goal: string;
};

export type BalanceTransferVerified = {
  optionCurrent: PayoffSimulation;
  optionTransfer: PayoffSimulation;
  netCostSavingsUsd: string | null;
  formattedPrompt: string;
};

export type RefinanceScenario = {
  principalUsd: number;
  currentAprPct: number;
  remainingMonths: number;
  newAprPct: number;
  newTermMonths: number;
  refiFeeUsd: number;
  goal: string;
};

export type LoanAmortization = {
  monthlyPaymentUsd: string;
  totalInterestUsd: string;
  upfrontFeeUsd: string;
  totalOutOfPocketUsd: string;
};

export type RefinanceVerified = {
  currentLoan: LoanAmortization;
  refiOffer: LoanAmortization;
  monthlyPaymentDeltaUsd: string;
  netTotalSavingsUsd: string;
  formattedPrompt: string;
};

function fmtUsd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100);
  const rem = String(abs % 100).padStart(2, "0");
  return `${sign}$${dollars.toLocaleString("en-US")}.${rem}`;
}

function simulateCardPayoffCents(
  startingBalanceCents: number,
  upfrontFeeCents: number,
  monthlyPaymentCents: number,
  promoAprPct: number,
  promoMonths: number,
  regularAprPct: number,
): PayoffSimulation {
  if (startingBalanceCents <= 0) {
    return {
      payable: true,
      months: 0,
      upfrontFeeUsd: fmtUsd(0),
      totalInterestUsd: fmtUsd(0),
      totalCostUsd: fmtUsd(0),
      remainingAtPromoEndUsd: fmtUsd(0),
    };
  }
  if (monthlyPaymentCents <= 0) {
    return {
      payable: false,
      months: null,
      upfrontFeeUsd: fmtUsd(upfrontFeeCents),
      totalInterestUsd: "Unavailable (payment <= $0)",
      totalCostUsd: "Unavailable",
    };
  }

  let balance = startingBalanceCents + upfrontFeeCents;
  let totalInterest = 0;
  let totalPaid = 0;
  let remainingAtPromoEnd = promoMonths === 0 ? balance : 0;

  for (let m = 1; m <= 600; m++) {
    const apr = m <= promoMonths ? promoAprPct : regularAprPct;
    const interest = Math.round((balance * (apr / 100)) / 12);
    if (interest >= monthlyPaymentCents && apr > 0) {
      return {
        payable: false,
        months: null,
        upfrontFeeUsd: fmtUsd(upfrontFeeCents),
        totalInterestUsd: "Exceeds monthly payment (negative/stalled amortization)",
        totalCostUsd: "Unavailable",
      };
    }
    const due = balance + interest;
    const payment = Math.min(due, monthlyPaymentCents);
    totalInterest += interest;
    totalPaid += payment;
    balance = due - payment;
    if (m === promoMonths) {
      remainingAtPromoEnd = balance;
    }
    if (balance <= 0) {
      if (m < promoMonths) remainingAtPromoEnd = 0;
      return {
        payable: true,
        months: m,
        upfrontFeeUsd: fmtUsd(upfrontFeeCents),
        totalInterestUsd: fmtUsd(totalInterest),
        totalCostUsd: fmtUsd(totalPaid),
        remainingAtPromoEndUsd: fmtUsd(remainingAtPromoEnd),
      };
    }
  }

  return {
    payable: false,
    months: null,
    upfrontFeeUsd: fmtUsd(upfrontFeeCents),
    totalInterestUsd: "Exceeds 600-month horizon",
    totalCostUsd: "Unavailable",
  };
}

export function computeBalanceTransferComparison(
  s: BalanceTransferScenario,
): BalanceTransferVerified {
  const balCents = Math.round(s.balanceUsd * 100);
  const payCents = Math.round(s.monthlyPaymentUsd * 100);
  const feeCents = Math.round(balCents * (s.transferFeePct / 100));

  const optionCurrent = simulateCardPayoffCents(
    balCents,
    0,
    payCents,
    s.currentAprPct,
    0,
    s.currentAprPct,
  );
  const optionTransfer = simulateCardPayoffCents(
    balCents,
    feeCents,
    payCents,
    s.promoAprPct,
    s.promoMonths,
    s.postPromoAprPct,
  );

  let netCostSavingsUsd: string | null = null;
  if (optionCurrent.payable && optionTransfer.payable) {
    const parseCents = (u: string) =>
      Math.round(Number(u.replace(/[^0-9.-]/g, "")) * 100);
    netCostSavingsUsd = fmtUsd(
      parseCents(optionCurrent.totalCostUsd) -
        parseCents(optionTransfer.totalCostUsd),
    );
  }

  const formattedPrompt = [
    "Caller authorization: Authorized by signed-in user for runtime financial comparison.",
    "Calculator verification status: VERIFIED (deterministic USD monthly-compounding cent simulation).",
    `User comparison goal: ${s.goal}`,
    "",
    "Normalized Financial Inputs (Currency: USD, Period: Monthly):",
    `- Starting credit card balance: ${fmtUsd(balCents)}`,
    `- Planned fixed monthly payment: ${fmtUsd(payCents)}/month`,
    `- Option A (Keep current card): ${s.currentAprPct.toFixed(2)}% purchase APR, $0.00 transfer fee.`,
    `- Option B (Balance transfer card): ${s.promoAprPct.toFixed(2)}% promotional APR for ${s.promoMonths} months, ${s.transferFeePct.toFixed(2)}% upfront balance transfer fee (${fmtUsd(feeCents)} added to balance), ${s.postPromoAprPct.toFixed(2)}% post-promotional APR thereafter.`,
    "",
    "Verified Calculator Outputs:",
    `- Option A (Current card): Payoff time = ${optionCurrent.months !== null ? `${optionCurrent.months} months` : "Not paid off"}, Total interest = ${optionCurrent.totalInterestUsd}, Total paid = ${optionCurrent.totalCostUsd}.`,
    `- Option B (Balance transfer): Upfront fee = ${optionTransfer.upfrontFeeUsd}, Balance remaining when ${s.promoMonths}-month promo ends = ${optionTransfer.remainingAtPromoEndUsd ?? "$0.00"}, Payoff time = ${optionTransfer.months !== null ? `${optionTransfer.months} months` : "Not paid off"}, Total post-promo interest = ${optionTransfer.totalInterestUsd}, Total paid (principal + fee + interest) = ${optionTransfer.totalCostUsd}.`,
    netCostSavingsUsd !== null
      ? `- Verified total-cost difference (Option A minus Option B): ${netCostSavingsUsd}.`
      : "- Verified total-cost difference: Unavailable because at least one schedule does not amortize.",
  ].join("\n");

  return {
    optionCurrent,
    optionTransfer,
    netCostSavingsUsd,
    formattedPrompt,
  };
}

function amortizeLoan(
  principalCents: number,
  aprPct: number,
  months: number,
  feeCents: number,
): {
  paymentCents: number;
  interestCents: number;
  totalOutCents: number;
  summary: LoanAmortization;
} {
  if (principalCents <= 0 || months <= 0) {
    return {
      paymentCents: 0,
      interestCents: 0,
      totalOutCents: feeCents,
      summary: {
        monthlyPaymentUsd: fmtUsd(0),
        totalInterestUsd: fmtUsd(0),
        upfrontFeeUsd: fmtUsd(feeCents),
        totalOutOfPocketUsd: fmtUsd(feeCents),
      },
    };
  }
  let paymentCents: number;
  if (aprPct === 0) {
    paymentCents = Math.round(principalCents / months);
  } else {
    const r = aprPct / 100 / 12;
    const rawPayment = (principalCents * r) / (1 - Math.pow(1 + r, -months));
    paymentCents = Math.round(rawPayment);
  }
  const totalScheduled = paymentCents * months;
  const interestCents = Math.max(0, totalScheduled - principalCents);
  const totalOutCents = principalCents + interestCents + feeCents;
  return {
    paymentCents,
    interestCents,
    totalOutCents,
    summary: {
      monthlyPaymentUsd: fmtUsd(paymentCents),
      totalInterestUsd: fmtUsd(interestCents),
      upfrontFeeUsd: fmtUsd(feeCents),
      totalOutOfPocketUsd: fmtUsd(totalOutCents),
    },
  };
}

export function computeRefinanceComparison(
  s: RefinanceScenario,
): RefinanceVerified {
  const prinCents = Math.round(s.principalUsd * 100);
  const feeCents = Math.round(s.refiFeeUsd * 100);

  const cur = amortizeLoan(prinCents, s.currentAprPct, s.remainingMonths, 0);
  const refi = amortizeLoan(prinCents, s.newAprPct, s.newTermMonths, feeCents);

  const monthlyDeltaCents = refi.paymentCents - cur.paymentCents;
  const netSavingsCents = cur.totalOutCents - refi.totalOutCents;

  const formattedPrompt = [
    "Caller authorization: Authorized by signed-in user for runtime loan refinancing comparison.",
    "Calculator verification status: VERIFIED (deterministic USD fixed-rate monthly amortization).",
    `User comparison goal: ${s.goal}`,
    "",
    "Normalized Financial Inputs (Currency: USD, Fixed-Rate Monthly Compounding):",
    `- Current loan: ${fmtUsd(prinCents)} principal balance, ${s.currentAprPct.toFixed(2)}% APR, ${s.remainingMonths} months remaining, $0.00 fee.`,
    `- Refinance offer: ${fmtUsd(prinCents)} principal balance, ${s.newAprPct.toFixed(2)}% APR, ${s.newTermMonths}-month term, ${fmtUsd(feeCents)} upfront origination/closing fee.`,
    "",
    "Verified Calculator Outputs:",
    `- Current loan: Monthly payment = ${cur.summary.monthlyPaymentUsd}, Remaining interest = ${cur.summary.totalInterestUsd}, Total remaining payments = ${cur.summary.totalOutOfPocketUsd} over ${s.remainingMonths} months.`,
    `- Refinance offer: Monthly payment = ${refi.summary.monthlyPaymentUsd}, Total interest = ${refi.summary.totalInterestUsd}, Upfront fee = ${refi.summary.upfrontFeeUsd}, Total out-of-pocket cost = ${refi.summary.totalOutOfPocketUsd} over ${s.newTermMonths} months.`,
    `- Monthly payment change (Refinance minus Current): ${fmtUsd(monthlyDeltaCents)}/month.`,
    `- Net total lifetime savings after fees (Current total cost minus Refinance total cost): ${fmtUsd(netSavingsCents)}.`,
  ].join("\n");

  return {
    currentLoan: cur.summary,
    refiOffer: refi.summary,
    monthlyPaymentDeltaUsd: fmtUsd(monthlyDeltaCents),
    netTotalSavingsUsd: fmtUsd(netSavingsCents),
    formattedPrompt,
  };
}

export const ADVISOR_PRESETS: {
  id: string;
  label: string;
  prompt: string;
}[] = [
  {
    id: "balance-transfer",
    label: "24.49% Card vs. 0% 15-mo Balance Transfer",
    prompt: computeBalanceTransferComparison({
      balanceUsd: 2387.65,
      currentAprPct: 24.49,
      monthlyPaymentUsd: 200,
      transferFeePct: 3.0,
      promoAprPct: 0.0,
      promoMonths: 15,
      postPromoAprPct: 21.99,
      goal: "Minimize total interest and fees while keeping my monthly payment at $200.00/month.",
    }).formattedPrompt,
  },
  {
    id: "refinance-term-tradeoff",
    label: "Loan Refinance: 60-mo Lower Payment vs. Total Cost",
    prompt: computeRefinanceComparison({
      principalUsd: 18500,
      currentAprPct: 6.8,
      remainingMonths: 36,
      newAprPct: 5.75,
      newTermMonths: 60,
      refiFeeUsd: 250,
      goal: "Understand whether lowering my monthly cash outflow by extending to 60 months actually saves or costs more in total interest and fees.",
    }).formattedPrompt,
  },
  {
    id: "refinance-same-term",
    label: "Loan Refinance: 6.80% vs. 5.10% Same 48-mo Term",
    prompt: computeRefinanceComparison({
      principalUsd: 18500,
      currentAprPct: 6.8,
      remainingMonths: 48,
      newAprPct: 5.1,
      newTermMonths: 48,
      refiFeeUsd: 185,
      goal: "Lower both my monthly payment and my total lifetime cost without extending my payoff date.",
    }).formattedPrompt,
  },
];
