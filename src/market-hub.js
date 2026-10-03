import { finitePositive } from './core.js';

export const BYBIT_MAX_ARGS_PER_SUBSCRIBE = 10;
export const MAX_MONITORED_SYMBOLS = 800;
export const BINANCE_SUBSCRIBE_CHUNK = 180;

const BINANCE_WS = 'wss://stream.binance.com:443/ws';
const BYBIT_WS = 'wss://stream.bybit.com/v5/public/spot';

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
    .sort((a, b) => {
      const al = Number(a.commonTurnover24hUsdt) || 0;
      const bl = Number(b.commonTurnover24hUsdt) || 0;
      return bl - al || a.symbol.localeCompare(b.symbol);
    })
    .slice(0, Math.max(1, Math.min(limit, MAX_MONITORED_SYMBOLS)))
    .map((x) => x.symbol);
}

export function buildCommonUsdtMarkets({
  binanceSymbols = [],
  bybitSymbols = [],
  binanceTickers = [],
  bybitTickers = [],
} = {}) {
  const bSymbols = new Map(
    binanceSymbols
      .filter((x) => x?.status === 'TRADING' && x?.quoteAsset === 'USDT' && x?.symbol && x?.baseAsset)
      .map((x) => [x.symbol, x]),
  );
  const ySymbols = new Map(
    bybitSymbols
      .filter((x) => x?.status === 'Trading' && x?.quoteCoin === 'USDT' && x?.symbol && x?.baseCoin)
      .map((x) => [x.symbol, x]),
  );
  const bTicker = new Map((binanceTickers || []).map((x) => [x.symbol, x]));
  const yTicker = new Map((bybitTickers || []).map((x) => [x.symbol, x]));

  const candidates = [];
  for (const [symbol, b] of bSymbols) {
    const y = ySymbols.get(symbol);
    if (!y || y.baseCoin !== b.baseAsset || y.quoteCoin !== b.quoteAsset) continue;

    const bt = bTicker.get(symbol);
    const yt = yTicker.get(symbol);
    const binanceTurnover24hUsdt = finitePositive(bt?.quoteVolume) || 0;
    const bybitTurnover24hUsdt = finitePositive(yt?.turnover24h) || 0;
    const commonTurnover24hUsdt = Math.min(binanceTurnover24hUsdt, bybitTurnover24hUsdt);

    candidates.push({
      base: b.baseAsset,
      name: b.baseAsset,
      symbol,
      quote: 'USDT',
      binanceActive: true,
      bybitActive: true,
      identityConfirmed: true,
      identityMethod: 'exact_symbol+base+quote+exchange_catalogs',
      binanceTurnover24hUsdt,
      bybitTurnover24hUsdt,
      commonTurnover24hUsdt,
    });
  }

  return candidates.sort((a, b) =>
    b.commonTurnover24hUsdt - a.commonTurnover24hUsdt || a.symbol.localeCompare(b.symbol)
  );
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

export function createMarketHub({ symbols = [], logger = console } = {}) {
  const monitored = [...new Set(symbols)].slice(0, MAX_MONITORED_SYMBOLS);
  const books = { binance: new Map(), bybit: new Map() };
  const status = {
    binance: { state: 'idle', last: null, error: null },
    bybit: { state: 'idle', last: null, error: null },
  };
  const diagnostics = {
    binanceFirstQuoteAt: null,
    bybitFirstQuoteAt: null,
    binanceSubscribedBatches: 0,
    bybitSubscribedBatches: 0,
    bybitRejectedTopics: [],
  };
  const sockets = { binance: null, bybit: null };
  const reconnectTimers = { binance: null, bybit: null };
  const timers = new Set();
  const bybitSubscriptionBatches = new Map();
  let stopped = false;
  let bybitHeartbeat = null;
  let bybitRetrySeq = 0;

  function later(fn, delay) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, delay);
    timers.add(timer);
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
        if (!symbol || !monitored.includes(symbol)) return;
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

  function sendBybitSubscribe(ws, args, reqId) {
    bybitSubscriptionBatches.set(reqId, args);
    ws.send(JSON.stringify({ req_id: reqId, op: 'subscribe', args }));
  }

  function connectBybit() {
    if (stopped || !monitored.length) return;
    try { sockets.bybit?.close(); } catch {}
    if (bybitHeartbeat) clearInterval(bybitHeartbeat);
    bybitSubscriptionBatches.clear();
    diagnostics.bybitRejectedTopics = [];
    diagnostics.bybitSubscribedBatches = 0;
    bybitRetrySeq = 0;
    setStatus('bybit', 'connecting');

    const ws = new WebSocket(BYBIT_WS);
    sockets.bybit = ws;

    ws.onopen = () => {
      logger.info('[market] Bybit WS conectado; assinando tickers');
      setStatus('bybit', 'connecting');
      const topics = monitored.map((s) => `tickers.${s}`);
      chunkTopics(topics).forEach((args, index) => {
        later(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          sendBybitSubscribe(ws, args, `tk-${index + 1}`);
        }, index * 100);
      });
      bybitHeartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 'ping' }));
      }, 20_000);
    };

    ws.onerror = () => setStatus('bybit', 'error', 'websocket_error');

    ws.onclose = (event) => {
      if (bybitHeartbeat) clearInterval(bybitHeartbeat);
      bybitHeartbeat = null;
      setStatus('bybit', 'disconnected', `close_${event?.code ?? 'unknown'}`);
      logger.warn('[market] Bybit WS desconectado', event?.code);
      scheduleReconnect('bybit', connectBybit);
    };

    ws.onmessage = (event) => {
      try {
        const msg = parseMessage(event);

        if (msg?.op === 'subscribe') {
          const reqId = msg.req_id || '';
          const batch = bybitSubscriptionBatches.get(reqId) || [];
          bybitSubscriptionBatches.delete(reqId);

          if (msg.success === false) {
            logger.warn('[market] Bybit subscribe falhou', reqId, msg.ret_msg || '');
            if (batch.length > 1) {
              for (const topic of batch) {
                bybitRetrySeq += 1;
                later(() => {
                  if (ws.readyState === WebSocket.OPEN) {
                    sendBybitSubscribe(ws, [topic], `retry-${bybitRetrySeq}`);
                  }
                }, bybitRetrySeq * 100);
              }
            } else if (batch.length === 1) {
              if (!diagnostics.bybitRejectedTopics.includes(batch[0])) {
                diagnostics.bybitRejectedTopics.push(batch[0]);
              }
              logger.warn('[market] Bybit tópico rejeitado', batch[0]);
            }
          } else {
            diagnostics.bybitSubscribedBatches += 1;
          }
          return;
        }

        if (msg?.op === 'ping' || msg?.ret_msg === 'pong') return;
        if (!msg?.topic?.startsWith('tickers.')) return;

        const raw = Array.isArray(msg.data) ? msg.data[0] : msg.data;
        const symbol = raw?.symbol || msg.topic.slice('tickers.'.length);
        if (!symbol || !monitored.includes(symbol)) return;

        const ts = Date.now();
        const book = topBook({
          bidPrice: raw?.bid1Price,
          bidQty: raw?.bid1Size,
          askPrice: raw?.ask1Price,
          askQty: raw?.ask1Size,
          ts,
        });
        if (!book) return;

        books.bybit.set(symbol, book);
        if (!diagnostics.bybitFirstQuoteAt) {
          diagnostics.bybitFirstQuoteAt = ts;
          logger.info('[market] Bybit primeira cotação', symbol);
        }
        touch('bybit', ts);
      } catch (error) {
        logger.warn('[market] Bybit mensagem inválida', error?.message || error);
      }
    };
  }

  function start() {
    stopped = false;
    connectBinance();
    connectBybit();
  }

  function stop() {
    stopped = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const key of Object.keys(reconnectTimers)) {
      if (reconnectTimers[key]) clearTimeout(reconnectTimers[key]);
      reconnectTimers[key] = null;
    }
    if (bybitHeartbeat) clearInterval(bybitHeartbeat);
    bybitHeartbeat = null;
    for (const ws of Object.values(sockets)) {
      try { ws?.close(); } catch {}
    }
  }

  function reconnect() {
    for (const ws of Object.values(sockets)) {
      try { ws?.close(); } catch {}
    }
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
