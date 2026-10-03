import { finitePositive } from './core.js';

export const MAX_MONITORED_SYMBOLS = 800;
export const BINANCE_SUBSCRIBE_CHUNK = 180;
export const GATE_SUBSCRIBE_CHUNK = 80;
export const AGGREGATE_POLL_MS = 1_000;

const BINANCE_WS = 'wss://stream.binance.com:443/ws';
const GATE_WS = 'wss://api.gateio.ws/ws/v4/';
const BYBIT_REST_BASES = ['https://api.bybit.com','https://api.bytick.com'];
const OKX_REST_BASES = ['https://www.okx.com','https://openapi.okx.com'];

export function chunkTopics(items, size = 10) {
  const n = Math.max(1, Number(size) || 10);
  const out = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

function canonicalSymbol(base, quote = 'USDT') {
  if (!base || quote !== 'USDT') return null;
  return `${String(base).toUpperCase()}USDT`;
}

export function buildMultiExchangeUniverse({
  bybitSymbols = [],
  okxSymbols = [],
  gateSymbols = [],
} = {}) {
  const map = new Map();

  const upsert = (base, venue) => {
    const symbol = canonicalSymbol(base);
    if (!symbol) return;
    const current = map.get(symbol) || {
      base: String(base).toUpperCase(),
      name: String(base).toUpperCase(),
      symbol,
      quote: 'USDT',
      venues: { binance:null, bybit:false, okx:false, gate:false },
      identityConfirmed: true,
      identityMethod: 'exact_base+USDT_exchange_catalog_or_live_probe',
    };
    current.venues[venue] = true;
    map.set(symbol, current);
  };

  for (const x of bybitSymbols) {
    if (x?.status === 'Trading' && x?.quoteCoin === 'USDT' && x?.baseCoin) {
      upsert(x.baseCoin, 'bybit');
    }
  }

  for (const x of okxSymbols) {
    if (x?.state === 'live' && x?.quoteCcy === 'USDT' && x?.baseCcy) {
      upsert(x.baseCcy, 'okx');
    }
  }

  for (const x of gateSymbols) {
    if (x?.trade_status === 'tradable' && x?.quote === 'USDT' && x?.base) {
      upsert(x.base, 'gate');
    }
  }

  return [...map.values()]
    .map((x) => ({
      ...x,
      catalogVenueCount: Object.values(x.venues).filter(Boolean).length,
    }))
    .sort((a, b) =>
      b.catalogVenueCount - a.catalogVenueCount || a.symbol.localeCompare(b.symbol)
    );
}

export function selectConfirmedSymbols(candidates, limit = MAX_MONITORED_SYMBOLS) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || MAX_MONITORED_SYMBOLS, MAX_MONITORED_SYMBOLS));
  return (candidates || [])
    .filter((x) => x?.identityConfirmed && typeof x.symbol === 'string')
    .sort((a, b) =>
      (Number(b.catalogVenueCount) || 0) - (Number(a.catalogVenueCount) || 0)
      || a.symbol.localeCompare(b.symbol)
    )
    .slice(0, safeLimit)
    .map((x) => x.symbol);
}

// Compatibility helper retained for older tests/callers.
export function buildCommonUsdtMarkets({ binanceSymbols = null, bybitSymbols = [] } = {}) {
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
        base:y.baseCoin,
        name:y.baseCoin,
        symbol:y.symbol,
        quote:'USDT',
        binanceActive:true,
        bybitActive:true,
        identityConfirmed:true,
        identityMethod:'exact_symbol+base+quote+exchange_catalogs',
      }))
      .sort((a,b)=>a.symbol.localeCompare(b.symbol));
  }

  return bybitActive.map((y)=>({
    base:y.baseCoin,
    name:y.baseCoin,
    symbol:y.symbol,
    quote:'USDT',
    binanceActive:null,
    bybitActive:true,
    identityConfirmed:true,
    identityMethod:'bybit_catalog+exact_symbol_live_probe_on_binance',
  })).sort((a,b)=>a.symbol.localeCompare(b.symbol));
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
  return { bids:[[b,B]], asks:[[a,A]], ts:t };
}

async function fetchJson(url, timeoutMs = 5_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent':'radar-cripto-carlos/0.18-recovery' },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchFirstJson(bases, path, validate) {
  const errors = [];
  for (const base of bases) {
    try {
      const data = await fetchJson(`${base}${path}`);
      if (!validate(data)) throw new Error('invalid_response');
      return { base, data };
    } catch (error) {
      errors.push(`${base}: ${error?.message || error}`);
    }
  }
  throw new Error(errors.join(' | '));
}

export function createMarketHub({ symbols = [], gateSymbols = [], logger = console } = {}) {
  const monitored = [...new Set(symbols)].slice(0, MAX_MONITORED_SYMBOLS);
  const monitoredSet = new Set(monitored);
  const gateSet = new Set(gateSymbols.filter((x)=>monitoredSet.has(x)));

  const books = {
    binance:new Map(),
    bybit:new Map(),
    okx:new Map(),
    gate:new Map(),
  };
  const status = {
    binance:{state:'idle',last:null,error:null},
    bybit:{state:'idle',last:null,error:null},
    okx:{state:'idle',last:null,error:null},
    gate:{state:'idle',last:null,error:null},
  };
  const diagnostics = {
    binanceFirstQuoteAt:null,
    bybitFirstQuoteAt:null,
    okxFirstQuoteAt:null,
    gateFirstQuoteAt:null,
    binanceSubscribedBatches:0,
    gateSubscribedBatches:0,
    bybitPollsOk:0,
    bybitPollsFailed:0,
    okxPollsOk:0,
    okxPollsFailed:0,
    bybitLastPollCount:0,
    okxLastPollCount:0,
    gateQuoteCount:0,
    bybitRestSource:null,
    okxRestSource:null,
  };

  const sockets = { binance:null, gate:null };
  const reconnectTimers = { binance:null, gate:null };
  const timers = new Set();
  let stopped = false;
  let bybitGeneration = 0;
  let okxGeneration = 0;

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
    status[exchange] = { state:'connected', last:ts, error:null };
  }

  function scheduleReconnect(exchange, connect) {
    if (stopped || reconnectTimers[exchange]) return;
    reconnectTimers[exchange] = setTimeout(() => {
      reconnectTimers[exchange] = null;
      connect();
    }, 2_000);
  }

  function storeBook(exchange, symbol, raw) {
    if (!symbol || !monitoredSet.has(symbol)) return false;
    const book = topBook({ ...raw, ts:Date.now() });
    if (!book) return false;
    books[exchange].set(symbol, book);
    touch(exchange, book.ts);
    return true;
  }

  function connectBinance() {
    if (stopped || !monitored.length) return;
    try { sockets.binance?.close(); } catch {}
    setStatus('binance','connecting');

    const ws = new WebSocket(BINANCE_WS);
    sockets.binance = ws;

    ws.onopen = () => {
      logger.info('[market] Binance WS conectado; assinando bookTicker');
      const topics = monitored.map((s)=>`${s.toLowerCase()}@bookTicker`);
      chunkTopics(topics, BINANCE_SUBSCRIBE_CHUNK).forEach((params,index)=>{
        later(()=>{
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({method:'SUBSCRIBE',params,id:index+1}));
        }, index * 300);
      });
    };
    ws.onerror = () => setStatus('binance','error','websocket_error');
    ws.onclose = (event) => {
      setStatus('binance','disconnected',`close_${event?.code ?? 'unknown'}`);
      logger.warn('[market] Binance WS desconectado', event?.code);
      scheduleReconnect('binance', connectBinance);
    };
    ws.onmessage = (event) => {
      try {
        const msg = parseMessage(event);
        if (Object.hasOwn(msg || {},'result') && Object.hasOwn(msg || {},'id')) {
          if (msg.result === null) diagnostics.binanceSubscribedBatches += 1;
          return;
        }
        const symbol = msg?.s;
        const ok = storeBook('binance',symbol,{
          bidPrice:msg.b,bidQty:msg.B,askPrice:msg.a,askQty:msg.A,
        });
        if (ok && !diagnostics.binanceFirstQuoteAt) {
          diagnostics.binanceFirstQuoteAt = Date.now();
          logger.info('[market] Binance primeira cotação', symbol);
        }
      } catch (error) {
        logger.warn('[market] Binance mensagem inválida', error?.message || error);
      }
    };
  }

  async function fetchBybitSnapshot() {
    const result = await fetchFirstJson(
      BYBIT_REST_BASES,
      '/v5/market/tickers?category=spot',
      (data)=>data?.retCode === 0 && Array.isArray(data?.result?.list),
    );
    return { base:result.base, list:result.data.result.list };
  }

  function connectBybit() {
    if (stopped || !monitored.length) return;
    const generation = ++bybitGeneration;
    setStatus('bybit','connecting');

    const poll = async () => {
      if (stopped || generation !== bybitGeneration) return;
      try {
        const result = await fetchBybitSnapshot();
        let count = 0;
        for (const raw of result.list) {
          if (storeBook('bybit',raw?.symbol,{
            bidPrice:raw?.bid1Price,bidQty:raw?.bid1Size,
            askPrice:raw?.ask1Price,askQty:raw?.ask1Size,
          })) count += 1;
        }
        diagnostics.bybitPollsOk += 1;
        diagnostics.bybitLastPollCount = count;
        diagnostics.bybitRestSource = result.base;
        if (count > 0 && !diagnostics.bybitFirstQuoteAt) {
          diagnostics.bybitFirstQuoteAt = Date.now();
          logger.info('[market] Bybit primeiro snapshot agregado',count,'pares');
        }
        if (count === 0) setStatus('bybit','error','empty_ticker_snapshot');
      } catch (error) {
        diagnostics.bybitPollsFailed += 1;
        setStatus('bybit','error',error?.message || 'rest_poll_failed');
        logger.warn('[market] Bybit snapshot falhou',error?.message || error);
      } finally {
        if (!stopped && generation === bybitGeneration) later(poll,AGGREGATE_POLL_MS);
      }
    };
    poll();
  }

  async function fetchOkxSnapshot() {
    const result = await fetchFirstJson(
      OKX_REST_BASES,
      '/api/v5/market/tickers?instType=SPOT',
      (data)=>data?.code === '0' && Array.isArray(data?.data),
    );
    return { base:result.base, list:result.data.data };
  }

  function connectOkx() {
    if (stopped || !monitored.length) return;
    const generation = ++okxGeneration;
    setStatus('okx','connecting');

    const poll = async () => {
      if (stopped || generation !== okxGeneration) return;
      try {
        const result = await fetchOkxSnapshot();
        let count = 0;
        for (const raw of result.list) {
          const instId = String(raw?.instId || '');
          if (!instId.endsWith('-USDT')) continue;
          const base = instId.slice(0,-5);
          const symbol = canonicalSymbol(base);
          if (storeBook('okx',symbol,{
            bidPrice:raw?.bidPx,bidQty:raw?.bidSz,
            askPrice:raw?.askPx,askQty:raw?.askSz,
          })) count += 1;
        }
        diagnostics.okxPollsOk += 1;
        diagnostics.okxLastPollCount = count;
        diagnostics.okxRestSource = result.base;
        if (count > 0 && !diagnostics.okxFirstQuoteAt) {
          diagnostics.okxFirstQuoteAt = Date.now();
          logger.info('[market] OKX primeiro snapshot agregado',count,'pares');
        }
        if (count === 0) setStatus('okx','error','empty_ticker_snapshot');
      } catch (error) {
        diagnostics.okxPollsFailed += 1;
        setStatus('okx','error',error?.message || 'rest_poll_failed');
        logger.warn('[market] OKX snapshot falhou',error?.message || error);
      } finally {
        if (!stopped && generation === okxGeneration) later(poll,AGGREGATE_POLL_MS);
      }
    };
    poll();
  }

  function connectGate() {
    if (stopped || !gateSet.size) {
      setStatus('gate','idle','no_symbols');
      return;
    }
    try { sockets.gate?.close(); } catch {}
    setStatus('gate','connecting');

    const ws = new WebSocket(GATE_WS);
    sockets.gate = ws;

    ws.onopen = () => {
      logger.info('[market] Gate WS conectado; assinando spot.book_ticker');
      const pairs = [...gateSet].map((symbol)=>`${symbol.slice(0,-4)}_USDT`);
      chunkTopics(pairs,GATE_SUBSCRIBE_CHUNK).forEach((payload,index)=>{
        later(()=>{
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({
            time:Math.floor(Date.now()/1000),
            channel:'spot.book_ticker',
            event:'subscribe',
            payload,
          }));
          diagnostics.gateSubscribedBatches += 1;
        }, index * 250);
      });
    };
    ws.onerror = () => setStatus('gate','error','websocket_error');
    ws.onclose = (event) => {
      setStatus('gate','disconnected',`close_${event?.code ?? 'unknown'}`);
      logger.warn('[market] Gate WS desconectado',event?.code);
      scheduleReconnect('gate',connectGate);
    };
    ws.onmessage = (event) => {
      try {
        const msg = parseMessage(event);
        if (msg?.channel !== 'spot.book_ticker' || msg?.event !== 'update') return;
        const raw = msg.result;
        const pair = String(raw?.s || '');
        if (!pair.endsWith('_USDT')) return;
        const symbol = canonicalSymbol(pair.slice(0,-5));
        const ok = storeBook('gate',symbol,{
          bidPrice:raw?.b,bidQty:raw?.B,
          askPrice:raw?.a,askQty:raw?.A,
        });
        if (ok) {
          diagnostics.gateQuoteCount += 1;
          if (!diagnostics.gateFirstQuoteAt) {
            diagnostics.gateFirstQuoteAt = Date.now();
            logger.info('[market] Gate primeira cotação',symbol);
          }
        }
      } catch (error) {
        logger.warn('[market] Gate mensagem inválida',error?.message || error);
      }
    };
  }

  function start() {
    stopped = false;
    connectBinance();
    connectBybit();
    connectOkx();
    connectGate();
  }

  function stop() {
    stopped = true;
    bybitGeneration += 1;
    okxGeneration += 1;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const key of Object.keys(reconnectTimers)) {
      if (reconnectTimers[key]) clearTimeout(reconnectTimers[key]);
      reconnectTimers[key] = null;
    }
    for (const ws of Object.values(sockets)) {
      try { ws?.close(); } catch {}
    }
  }

  function reconnect() {
    bybitGeneration += 1;
    okxGeneration += 1;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const ws of Object.values(sockets)) {
      try { ws?.close(); } catch {}
    }
    later(()=>{
      if (!stopped) {
        connectBinance();
        connectBybit();
        connectOkx();
        connectGate();
      }
    },250);
  }

  function snapshot() {
    const serialize = (map)=>Object.fromEntries([...map.entries()]);
    return {
      generatedAt:Date.now(),
      status,
      symbols:monitored,
      diagnostics,
      books:{
        binance:serialize(books.binance),
        bybit:serialize(books.bybit),
        okx:serialize(books.okx),
        gate:serialize(books.gate),
      },
    };
  }

  return { start, stop, reconnect, snapshot };
}
