import { finitePositive } from './core.js';

export const BYBIT_MAX_ARGS_PER_SUBSCRIBE = 10;
export const MAX_MONITORED_SYMBOLS = 800;
export const BINANCE_SUBSCRIBE_CHUNK = 180;
export const BYBIT_POLL_MS = 1_000;

const BINANCE_WS = 'wss://stream.binance.com:443/ws';
const BYBIT_REST_BASES = ['https://api.bybit.com','https://api.bytick.com'];

export function chunkTopics(items, size = BYBIT_MAX_ARGS_PER_SUBSCRIBE) {
  const n = Math.max(1, Number(size) || BYBIT_MAX_ARGS_PER_SUBSCRIBE);
  const out = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

export function selectConfirmedSymbols(candidates, preferredOrLimit = MAX_MONITORED_SYMBOLS, maybeLimit) {
  const limit = Number.isFinite(Number(maybeLimit))
    ? Number(maybeLimit)
    : Number.isFinite(Number(preferredOrLimit))
      ? Number(preferredOrLimit)
      : MAX_MONITORED_SYMBOLS;

  return (candidates || [])
    .filter((x) => x?.identityConfirmed && typeof x.symbol === 'string')
    .sort((a, b) => a.symbol.localeCompare(b.symbol))
    .slice(0, Math.max(1, Math.min(limit, MAX_MONITORED_SYMBOLS)))
    .map((x) => x.symbol);
}

export function buildCommonUsdtMarkets({
  binanceSymbols = null,
  bybitSymbols = [],
} = {}) {
  const bybitActive = (bybitSymbols || [])
    .filter((x) => x?.status === 'Trading' && x?.quoteCoin === 'USDT' && x?.symbol && x?.baseCoin);

  if (Array.isArray(binanceSymbols)) {
    const bSymbols = new Map(
      binanceSymbols
        .filter((x) => x?.status === 'TRADING' && x?.quoteAsset === 'USDT' && x?.symbol && x?.baseAsset)
        .map((x) => [x.symbol, x]),
    );

    return bybitActive
      .filter((y) => {
        const b = bSymbols.get(y.symbol);
        return b && b.baseAsset === y.baseCoin && b.quoteAsset === y.quoteCoin;
      })
      .map((y) => ({
        base: y.baseCoin,
        name: y.baseCoin,
        symbol: y.symbol,
        quote: 'USDT',
        binanceActive: true,
        bybitActive: true,
        identityConfirmed: true,
        identityMethod: 'exact_symbol+base+quote+exchange_catalogs',
      }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  return bybitActive
    .map((y) => ({
      base: y.baseCoin,
      name: y.baseCoin,
      symbol: y.symbol,
      quote: 'USDT',
      binanceActive: null,
      bybitActive: true,
      identityConfirmed: true,
      identityMethod: 'bybit_catalog+exact_symbol_live_probe_on_binance',
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function parseMessage(event) {
  if (typeof event?.data === 'string') return JSON.parse(event.data);
  return JSON.parse(String(event?.data ?? ''));
}

function topBook({ bidPrice, bidQty, askPrice, askQty, ts }) {
  const b = finitePositive(bidPrice);
  const B = finitePositive(bidQty);
  const a = finitePositive(askPrice);
  const A = finitePositive(askQty);
  const t = Number(ts);
  if (!b || !B || !a || !A || !Number.isFinite(t)) return null;
  return { bids: [[b, B]], asks: [[a, A]], ts: t };
}

async function fetchJson(url, timeoutMs = 5_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'radar-cripto-carlos/0.17-recovery' },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timeout);
  }
}

export function createMarketHub({ symbols = [], logger = console } = {}) {
  const monitored = [...new Set(symbols)].slice(0, MAX_MONITORED_SYMBOLS);
  const monitoredSet = new Set(monitored);
  const books = { binance: new Map(), bybit: new Map() };
  const status = {
    binance: { state: 'idle', last: null, error: null },
    bybit: { state: 'idle', last: null, error: null },
  };
  const diagnostics = {
    binanceFirstQuoteAt: null,
    bybitFirstQuoteAt: null,
    binanceSubscribedBatches: 0,
    bybitPollsOk: 0,
    bybitPollsFailed: 0,
    bybitLastPollCount: 0,
    bybitRestSource: null,
  };
  const sockets = { binance: null };
  const reconnectTimers = { binance: null };
  const timers = new Set();
  let stopped = false;
  let bybitGeneration = 0;

  function later(fn, delay) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, delay);
    timers.add(timer);
    return timer;
  }

  function setStatus(exchange, state, error = null) {
    status[exchange] = { ...status[exchange], state, error };
  }

  function touch(exchange, ts = Date.now()) {
    status[exchange] = { state: 'connected', last: ts, error: null };
  }

  function scheduleReconnect(exchange, connect) {
    if (stopped || reconnectTimers[exchange]) return;
    reconnectTimers[exchange] = setTimeout(() => {
      reconnectTimers[exchange] = null;
      connect();
    }, 2_000);
  }

  function connectBinance() {
    if (stopped || !monitored.length) return;
    try { sockets.binance?.close(); } catch {}
    setStatus('binance', 'connecting');

    const ws = new WebSocket(BINANCE_WS);
    sockets.binance = ws;

    ws.onopen = () => {
      logger.info('[market] Binance WS conectado; assinando bookTicker');
      setStatus('binance', 'connecting');
      const topics = monitored.map((s) => `${s.toLowerCase()}@bookTicker`);
      chunkTopics(topics, BINANCE_SUBSCRIBE_CHUNK).forEach((params, index) => {
        later(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({
            method: 'SUBSCRIBE',
            params,
            id: index + 1,
          }));
        }, index * 300);
      });
    };

    ws.onerror = () => setStatus('binance', 'error', 'websocket_error');

    ws.onclose = (event) => {
      setStatus('binance', 'disconnected', `close_${event?.code ?? 'unknown'}`);
      logger.warn('[market] Binance WS desconectado', event?.code);
      scheduleReconnect('binance', connectBinance);
    };

    ws.onmessage = (event) => {
      try {
        const msg = parseMessage(event);
        if (Object.hasOwn(msg || {}, 'result') && Object.hasOwn(msg || {}, 'id')) {
          if (msg.result === null) diagnostics.binanceSubscribedBatches += 1;
          return;
        }
        const symbol = msg?.s;
        if (!symbol || !monitoredSet.has(symbol)) return;

        const ts = Date.now();
        const book = topBook({
          bidPrice: msg.b,
          bidQty: msg.B,
          askPrice: msg.a,
          askQty: msg.A,
          ts,
        });
        if (!book) return;

        books.binance.set(symbol, book);
        if (!diagnostics.binanceFirstQuoteAt) {
          diagnostics.binanceFirstQuoteAt = ts;
          logger.info('[market] Binance primeira cotação', symbol);
        }
        touch('binance', ts);
      } catch (error) {
        logger.warn('[market] Binance mensagem inválida', error?.message || error);
      }
    };
  }

  async function fetchBybitSnapshot() {
    const errors = [];
    for (const base of BYBIT_REST_BASES) {
      try {
        const data = await fetchJson(`${base}/v5/market/tickers?category=spot`);
        if (data?.retCode !== 0 || !Array.isArray(data?.result?.list)) {
          throw new Error(data?.retMsg || 'invalid_response');
        }
        return { base, list: data.result.list };
      } catch (error) {
        errors.push(`${base}: ${error?.message || error}`);
      }
    }
    throw new Error(errors.join(' | '));
  }

  function connectBybit() {
    if (stopped || !monitored.length) return;
    const generation = ++bybitGeneration;
    setStatus('bybit', 'connecting');

    const poll = async () => {
      if (stopped || generation !== bybitGeneration) return;

      try {
        const result = await fetchBybitSnapshot();
        const ts = Date.now();
        let count = 0;

        for (const raw of result.list) {
          const symbol = raw?.symbol;
          if (!symbol || !monitoredSet.has(symbol)) continue;

          const book = topBook({
            bidPrice: raw?.bid1Price,
            bidQty: raw?.bid1Size,
            askPrice: raw?.ask1Price,
            askQty: raw?.ask1Size,
            ts,
          });
          if (!book) continue;

          books.bybit.set(symbol, book);
          count += 1;
        }

        diagnostics.bybitPollsOk += 1;
        diagnostics.bybitLastPollCount = count;
        diagnostics.bybitRestSource = result.base;

        if (count > 0) {
          if (!diagnostics.bybitFirstQuoteAt) {
            diagnostics.bybitFirstQuoteAt = ts;
            logger.info('[market] Bybit primeiro snapshot agregado', count, 'pares');
          }
          touch('bybit', ts);
        } else {
          setStatus('bybit', 'error', 'empty_ticker_snapshot');
        }
      } catch (error) {
        diagnostics.bybitPollsFailed += 1;
        setStatus('bybit', 'error', error?.message || 'rest_poll_failed');
        logger.warn('[market] Bybit snapshot falhou', error?.message || error);
      } finally {
        if (!stopped && generation === bybitGeneration) {
          later(poll, BYBIT_POLL_MS);
        }
      }
    };

    poll();
  }

  function start() {
    stopped = false;
    connectBinance();
    connectBybit();
  }

  function stop() {
    stopped = true;
    bybitGeneration += 1;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    if (reconnectTimers.binance) clearTimeout(reconnectTimers.binance);
    reconnectTimers.binance = null;
    try { sockets.binance?.close(); } catch {}
  }

  function reconnect() {
    bybitGeneration += 1;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    try { sockets.binance?.close(); } catch {}

    later(() => {
      if (!stopped) {
        connectBinance();
        connectBybit();
      }
    }, 250);
  }

  function snapshot() {
    const serialize = (map) => Object.fromEntries(
      [...map.entries()].map(([symbol, book]) => [symbol, book]),
    );

    return {
      generatedAt: Date.now(),
      status,
      symbols: monitored,
      diagnostics,
      books: {
        binance: serialize(books.binance),
        bybit: serialize(books.bybit),
      },
    };
  }

  return { start, stop, reconnect, snapshot };
}
