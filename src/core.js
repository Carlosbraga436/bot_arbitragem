export const DEFAULT_COSTS = Object.freeze({
  binanceFeePct: 0.10,
  bybitFeePct: 0.10,
  reservePct: 0.05,
  recompositionUsdt: 0.50,
});

export const DEFAULT_RULES = Object.freeze({
  maxAgeMs: 5_000,
  maxSkewMs: 2_000,
  minBudgetFillPct: 100,
});

export function finitePositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function normalizeBook(book) {
  if (!book || !Array.isArray(book.bids) || !Array.isArray(book.asks)) return null;
  const mapSide = (levels, direction) => levels
    .map(([p, q]) => [finitePositive(p), finitePositive(q)])
    .filter(([p, q]) => p && q)
    .sort((a, b) => direction * (a[0] - b[0]));

  const bids = mapSide(book.bids, -1);
  const asks = mapSide(book.asks, 1);
  const ts = Number(book.ts);
  if (!bids.length || !asks.length || !Number.isFinite(ts)) return null;
  return { bids, asks, ts };
}

export function applyOrderBookMessage(previous, update, type = 'snapshot', depth = 50) {
  if (!update || !Array.isArray(update.bids) || !Array.isArray(update.asks)) return null;

  const clean = (levels) => levels
    .map(([p, q]) => [finitePositive(p), Number(q)])
    .filter(([p, q]) => p && Number.isFinite(q) && q >= 0);

  const makeSide = (previousLevels, changes, descending) => {
    const map = new Map();
    if (type !== 'snapshot') {
      for (const [p, q] of clean(previousLevels || [])) {
        if (q > 0) map.set(p, q);
      }
    }
    for (const [p, q] of clean(changes)) {
      if (q === 0) map.delete(p);
      else map.set(p, q);
    }
    return [...map.entries()]
      .sort((a, b) => descending ? b[0] - a[0] : a[0] - b[0])
      .slice(0, depth);
  };

  if (type !== 'snapshot' && !previous) return null;
  const ts = Number(update.ts);
  if (!Number.isFinite(ts)) return null;
  return {
    bids: makeSide(previous?.bids, update.bids, true),
    asks: makeSide(previous?.asks, update.asks, false),
    ts,
  };
}

export function consumeQuote(asks, quoteBudget) {
  let quoteLeft = finitePositive(quoteBudget);
  if (!quoteLeft) return null;
  let baseQty = 0;
  let quoteSpent = 0;

  for (const [price, qty] of asks) {
    const levelQuote = price * qty;
    const takeQuote = Math.min(quoteLeft, levelQuote);
    const takeBase = takeQuote / price;
    baseQty += takeBase;
    quoteSpent += takeQuote;
    quoteLeft -= takeQuote;
    if (quoteLeft <= 1e-9) break;
  }

  return {
    filled: quoteLeft <= 1e-9,
    baseQty,
    quoteSpent,
    vwap: baseQty > 0 ? quoteSpent / baseQty : null,
    fillPct: quoteBudget > 0 ? (quoteSpent / quoteBudget) * 100 : 0,
  };
}

export function consumeBase(bids, baseQty) {
  let baseLeft = finitePositive(baseQty);
  if (!baseLeft) return null;
  let baseSold = 0;
  let quoteReceived = 0;

  for (const [price, qty] of bids) {
    const takeBase = Math.min(baseLeft, qty);
    baseSold += takeBase;
    quoteReceived += takeBase * price;
    baseLeft -= takeBase;
    if (baseLeft <= 1e-12) break;
  }

  return {
    filled: baseLeft <= 1e-12,
    baseSold,
    quoteReceived,
    vwap: baseSold > 0 ? quoteReceived / baseSold : null,
    fillPct: baseQty > 0 ? (baseSold / baseQty) * 100 : 0,
  };
}

function pctToRate(pct) {
  const n = Number(pct);
  return Number.isFinite(n) && n >= 0 ? n / 100 : 0;
}

export function evaluateRoute({
  symbol,
  identityConfirmed,
  buyExchange,
  sellExchange,
  buyBook,
  sellBook,
  budgetUsdt,
  costs = DEFAULT_COSTS,
  rules = DEFAULT_RULES,
  now = Date.now(),
}) {
  if (!identityConfirmed) return { eligible: false, reason: 'identity_unconfirmed', symbol };
  if (!symbol || buyExchange === sellExchange) return { eligible: false, reason: 'invalid_route', symbol };

  const buy = normalizeBook(buyBook);
  const sell = normalizeBook(sellBook);
  const budget = finitePositive(budgetUsdt);
  if (!buy || !sell || !budget) return { eligible: false, reason: 'invalid_data', symbol };

  const buyAgeMs = now - buy.ts;
  const sellAgeMs = now - sell.ts;
  const skewMs = Math.abs(buy.ts - sell.ts);
  if (buyAgeMs < 0 || sellAgeMs < 0 || buyAgeMs > rules.maxAgeMs || sellAgeMs > rules.maxAgeMs) {
    return { eligible: false, reason: 'stale_data', symbol, buyAgeMs, sellAgeMs };
  }
  if (skewMs > rules.maxSkewMs) return { eligible: false, reason: 'desynced_data', symbol, skewMs };

  const bought = consumeQuote(buy.asks, budget);
  if (!bought?.filled || bought.fillPct < rules.minBudgetFillPct) {
    return { eligible: false, reason: 'insufficient_buy_liquidity', symbol, fillPct: bought?.fillPct ?? 0 };
  }

  const sold = consumeBase(sell.bids, bought.baseQty);
  if (!sold?.filled || sold.fillPct < rules.minBudgetFillPct) {
    return { eligible: false, reason: 'insufficient_sell_liquidity', symbol, fillPct: sold?.fillPct ?? 0 };
  }

  const buyFeeRate = pctToRate(buyExchange === 'binance' ? costs.binanceFeePct : costs.bybitFeePct);
  const sellFeeRate = pctToRate(sellExchange === 'binance' ? costs.binanceFeePct : costs.bybitFeePct);
  const reserveRate = pctToRate(costs.reservePct);
  const grossPnl = sold.quoteReceived - bought.quoteSpent;
  const tradingFees = bought.quoteSpent * buyFeeRate + sold.quoteReceived * sellFeeRate;
  const reserve = (bought.quoteSpent + sold.quoteReceived) * reserveRate;
  const recomposition = Math.max(0, Number(costs.recompositionUsdt) || 0);
  const netPnl = grossPnl - tradingFees - reserve - recomposition;
  const totalCapital = budget * 2;

  return {
    eligible: netPnl > 0,
    reason: netPnl > 0 ? 'positive_net' : 'non_positive_net',
    symbol,
    buyExchange,
    sellExchange,
    budgetUsdt: budget,
    baseQty: bought.baseQty,
    buyVwap: bought.vwap,
    sellVwap: sold.vwap,
    grossPnlUsdt: grossPnl,
    tradingFeesUsdt: tradingFees,
    reserveUsdt: reserve,
    recompositionUsdt: recomposition,
    netPnlUsdt: netPnl,
    netPctOnBuy: (netPnl / budget) * 100,
    roiOnTotalCapitalPct: (netPnl / totalCapital) * 100,
    buyAgeMs,
    sellAgeMs,
    skewMs,
  };
}

export function evaluatePair({ symbol, identityConfirmed, binanceBook, bybitBook, budgetUsdt, costs, rules, now }) {
  const routes = [
    evaluateRoute({ symbol, identityConfirmed, buyExchange: 'binance', sellExchange: 'bybit', buyBook: binanceBook, sellBook: bybitBook, budgetUsdt, costs, rules, now }),
    evaluateRoute({ symbol, identityConfirmed, buyExchange: 'bybit', sellExchange: 'binance', buyBook: bybitBook, sellBook: binanceBook, budgetUsdt, costs, rules, now }),
  ];
  return routes.sort((a, b) => (b.netPnlUsdt ?? -Infinity) - (a.netPnlUsdt ?? -Infinity))[0];
}

export function topPositive(results, limit = 5) {
  return results
    .filter((r) => r?.eligible && Number.isFinite(r.netPnlUsdt) && r.netPnlUsdt > 0)
    .sort((a, b) => b.netPnlUsdt - a.netPnlUsdt)
    .slice(0, limit);
}
