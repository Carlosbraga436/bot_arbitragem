import { applyOrderBookMessage } from './core.js';

export const PREFERRED_SYMBOLS = [
  'BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','DOGEUSDT',
  'ADAUSDT','AVAXUSDT','LINKUSDT','BCHUSDT','LTCUSDT',
  'DOTUSDT','TRXUSDT','TONUSDT','SHIBUSDT','NEARUSDT',
];
export const DEFAULT_SYMBOLS = PREFERRED_SYMBOLS;
export const BYBIT_MAX_ARGS_PER_SUBSCRIBE = 10;

const BINANCE_WS = 'wss://stream.binance.com:443/stream';
const BYBIT_WS = 'wss://stream.bybit.com/v5/public/spot';

export function chunkTopics(items, size = BYBIT_MAX_ARGS_PER_SUBSCRIBE) {
  const n = Math.max(1, Number(size) || BYBIT_MAX_ARGS_PER_SUBSCRIBE);
  const out = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

export function selectConfirmedSymbols(candidates, preferred = PREFERRED_SYMBOLS, limit = 15) {
  const order = new Map(preferred.map((symbol, index) => [symbol, index]));
  return (candidates || [])
    .filter((x) => x?.identityConfirmed && typeof x.symbol === 'string')
    .sort((a, b) => {
      const ai = order.has(a.symbol) ? order.get(a.symbol) : Number.MAX_SAFE_INTEGER;
      const bi = order.has(b.symbol) ? order.get(b.symbol) : Number.MAX_SAFE_INTEGER;
      return ai - bi || a.symbol.localeCompare(b.symbol);
    })
    .slice(0, limit)
    .map((x) => x.symbol);
}

function parseMessage(event) {
  if (typeof event?.data === 'string') return JSON.parse(event.data);
  return JSON.parse(String(event?.data ?? ''));
}

export function createMarketHub({ symbols = DEFAULT_SYMBOLS, logger = console } = {}) {
  const books = { binance: new Map(), bybit: new Map() };
  const status = {
    binance: { state: 'idle', last: null, error: null },
    bybit: { state: 'idle', last: null, error: null },
  };
  const diagnostics = {
    binanceFirstBookAt: null,
    bybitFirstBookAt: null,
    bybitRejectedTopics: [],
    bybitSubscribedBatches: 0,
  };
  const sockets = { binance: null, bybit: null };
  const reconnectTimers = { binance: null, bybit: null };
  const bybitSubscriptionBatches = new Map();
  let stopped = false;
  let bybitHeartbeat = null;
  let bybitRetrySeq = 0;

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
    if (stopped || !symbols.length) return;
    try { sockets.binance?.close(); } catch {}
    const streams = symbols.map((s) => `${s.toLowerCase()}@depth20@100ms`).join('/');
    setStatus('binance', 'connecting');
    const ws = new WebSocket(`${BINANCE_WS}?streams=${streams}`);
    sockets.binance = ws;

    ws.onopen = () => {
      logger.info('[market] Binance WS conectado');
      setStatus('binance', 'connecting');
    };
    ws.onerror = () => {
      setStatus('binance', 'error', 'websocket_error');
    };
    ws.onclose = (event) => {
      setStatus('binance', 'disconnected', `close_${event?.code ?? 'unknown'}`);
      logger.warn('[market] Binance WS desconectado', event?.code);
      scheduleReconnect('binance', connectBinance);
    };
    ws.onmessage = (event) => {
      try {
        const msg = parseMessage(event);
        const symbol = msg?.stream?.split('@')[0]?.toUpperCase();
        const data = msg?.data;
        if (!symbol || !Array.isArray(data?.bids) || !Array.isArray(data?.asks)) return;
        const ts = Date.now();
        books.binance.set(symbol, { bids: data.bids, asks: data.asks, ts });
        if (!diagnostics.binanceFirstBookAt) {
          diagnostics.binanceFirstBookAt = ts;
          logger.info('[market] Binance primeiro book', symbol);
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
    if (stopped || !symbols.length) return;
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
      logger.info('[market] Bybit WS conectado; assinando tópicos');
      setStatus('bybit', 'connecting');
      const topics = symbols.map((s) => `orderbook.50.${s}`);
      chunkTopics(topics).forEach((args, index) => {
        sendBybitSubscribe(ws, args, `ob-${index + 1}`);
      });
      bybitHeartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 'ping' }));
      }, 20_000);
    };

    ws.onerror = () => {
      setStatus('bybit', 'error', 'websocket_error');
    };

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
                sendBybitSubscribe(ws, [topic], `retry-${bybitRetrySeq}`);
              }
            } else if (batch.length === 1) {
              if (!diagnostics.bybitRejectedTopics.includes(batch[0])) {
                diagnostics.bybitRejectedTopics.push(batch[0]);
              }
              logger.warn('[market] Bybit tópico rejeitado', batch[0]);
            }
          } else {
            diagnostics.bybitSubscribedBatches += 1;
            logger.info('[market] Bybit subscribe OK', reqId);
          }
          return;
        }

        if (msg?.op === 'ping' || msg?.ret_msg === 'pong') return;
        if (!msg?.topic?.startsWith('orderbook.')) return;

        const data = msg.data;
        if (!data?.s || !Array.isArray(data?.b) || !Array.isArray(data?.a)) return;

        const ts = Date.now();
        const next = applyOrderBookMessage(
          books.bybit.get(data.s),
          { bids: data.b, asks: data.a, ts },
          msg.type || 'snapshot',
          50,
        );
        if (!next) return;

        books.bybit.set(data.s, next);
        if (!diagnostics.bybitFirstBookAt) {
          diagnostics.bybitFirstBookAt = ts;
          logger.info('[market] Bybit primeiro book', data.s);
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
    for (const timer of Object.values(reconnectTimers)) if (timer) clearTimeout(timer);
    if (bybitHeartbeat) clearInterval(bybitHeartbeat);
    for (const ws of Object.values(sockets)) {
      try { ws?.close(); } catch {}
    }
  }

  function reconnect() {
    for (const ws of Object.values(sockets)) {
      try { ws?.close(); } catch {}
    }
    setTimeout(() => {
      if (!stopped) {
        connectBinance();
        connectBybit();
      }
    }, 250);
  }

  function snapshot() {
    const serialize = (map) => Object.fromEntries(
      [...map.entries()].map(([symbol, book]) => [
        symbol,
        {
          bids: (book.bids || []).slice(0, 20),
          asks: (book.asks || []).slice(0, 20),
          ts: book.ts,
        },
      ]),
    );

    return {
      generatedAt: Date.now(),
      status,
      symbols,
      diagnostics,
      books: {
        binance: serialize(books.binance),
        bybit: serialize(books.bybit),
      },
    };
  }

  return { start, stop, reconnect, snapshot };
}
