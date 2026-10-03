import { applyOrderBookMessage } from './core.js';

export const DEFAULT_SYMBOLS = [
  'BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','DOGEUSDT',
  'ADAUSDT','AVAXUSDT','LINKUSDT','BCHUSDT','LTCUSDT',
  'DOTUSDT','TRXUSDT','TONUSDT','SHIBUSDT','NEARUSDT',
];

const BINANCE_WS = 'wss://stream.binance.com:443/stream';
const BYBIT_WS = 'wss://stream.bybit.com/v5/public/spot';

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
  const sockets = { binance: null, bybit: null };
  const reconnectTimers = { binance: null, bybit: null };
  let stopped = false;
  let bybitHeartbeat = null;

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
    if (stopped) return;
    try { sockets.binance?.close(); } catch {}
    const streams = symbols.map((s) => `${s.toLowerCase()}@depth20@100ms`).join('/');
    setStatus('binance', 'connecting');
    const ws = new WebSocket(`${BINANCE_WS}?streams=${streams}`);
    sockets.binance = ws;

    ws.onopen = () => {
      logger.info('[market] Binance WS conectado');
      setStatus('binance', 'connected');
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
        touch('binance', ts);
      } catch (error) {
        logger.warn('[market] Binance mensagem inválida', error?.message || error);
      }
    };
  }

  function connectBybit() {
    if (stopped) return;
    try { sockets.bybit?.close(); } catch {}
    if (bybitHeartbeat) clearInterval(bybitHeartbeat);
    setStatus('bybit', 'connecting');
    const ws = new WebSocket(BYBIT_WS);
    sockets.bybit = ws;

    ws.onopen = () => {
      logger.info('[market] Bybit WS conectado');
      setStatus('bybit', 'connected');
      ws.send(JSON.stringify({
        op: 'subscribe',
        args: symbols.map((s) => `orderbook.50.${s}`),
      }));
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
      books: {
        binance: serialize(books.binance),
        bybit: serialize(books.bybit),
      },
    };
  }

  return { start, stop, reconnect, snapshot };
}
