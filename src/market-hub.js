import { finitePositive } from './core.js';

export const MAX_MONITORED_SYMBOLS = 2400;
export const BINANCE_DISCOVERY_STREAM = '!miniTicker@arr';
export const BINANCE_SUBSCRIBE_CHUNK = 40;
export const BINANCE_SUBSCRIBE_DELAY_MS = 1_200;
export const GATE_PAIRS_PER_SOCKET = 150;
export const GATE_SUBSCRIBE_CHUNK = 50;
export const GATE_SUBSCRIBE_DELAY_MS = 1_000;
export const GATE_HEARTBEAT_MS = 10_000;
export const AGGREGATE_POLL_MS = 1_000;
export const KUCOIN_POLL_MS = 4_000;
export const KUCOIN_MAX_BACKOFF_MS = 30_000;

const BINANCE_WS = 'wss://stream.binance.com:443/ws';
const BINANCE_DISCOVERY_WS = `${BINANCE_WS}/${BINANCE_DISCOVERY_STREAM}`;
const GATE_WS = 'wss://api.gateio.ws/ws/v4/';
const BYBIT_REST_BASES = ['https://api.bybit.com','https://api.bytick.com'];
const OKX_REST_BASES = ['https://www.okx.com','https://openapi.okx.com'];
const KUCOIN_REST_BASES = ['https://api.kucoin.com'];

export function chunkTopics(items, size = 10) {
  const n = Math.max(1, Number(size) || 10);
  const out = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

export function selectDiscoveredBinanceSymbols(events = [], monitoredSymbols = []) {
  const monitoredSet = monitoredSymbols instanceof Set ? monitoredSymbols : new Set(monitoredSymbols);
  return [...new Set(
    (Array.isArray(events) ? events : [])
      .map((x)=>String(x?.s || '').toUpperCase())
      .filter((symbol)=>symbol.endsWith('USDT') && monitoredSet.has(symbol))
  )];
}

function canonicalSymbol(base, quote = 'USDT') {
  if (!base || quote !== 'USDT') return null;
  return `${String(base).toUpperCase()}USDT`;
}

export function buildMultiExchangeUniverse({
  bybitSymbols = [],
  okxSymbols = [],
  gateSymbols = [],
  kucoinSymbols = [],
} = {}) {
  const map = new Map();

  const upsert = (base, venue, feePct = null) => {
    const symbol = canonicalSymbol(base);
    if (!symbol) return;
    const current = map.get(symbol) || {
      base: String(base).toUpperCase(),
      name: String(base).toUpperCase(),
      symbol,
      quote: 'USDT',
      venues: { binance:null, bybit:false, okx:false, gate:false, kucoin:false },
      feePctByExchange: {},
      identityConfirmed: true,
      identityMethod: 'exact_base+USDT_exchange_catalog_or_live_probe',
    };
    current.venues[venue] = true;
    if (Number.isFinite(Number(feePct)) && Number(feePct) >= 0) {
      current.feePctByExchange[venue] = Number(feePct);
    }
    map.set(symbol, current);
  };

  const kucoinFeePct = (x) => {
    const raw = String(x?.feeCategory ?? '').toLowerCase();
    const base = raw.includes('classa') || raw === '1' ? 0.10
      : raw.includes('classb') || raw === '2' ? 0.20
      : raw.includes('classc') || raw === '3' ? 0.30
      : 0.30;
    const coefficient = Number(x?.takerFeeCoefficient);
    return base * (Number.isFinite(coefficient) && coefficient > 0 ? coefficient : 1);
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

  for (const x of kucoinSymbols) {
    const enabled = x?.tradingStatus === 'TradingEnabled' || x?.enableTrading === true;
    if (enabled && x?.quoteCurrency === 'USDT' && x?.baseCurrency) {
      upsert(x.baseCurrency, 'kucoin', kucoinFeePct(x));
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

export function createMarketHub({ symbols = [], gateSymbols = [], kucoinSymbols = [], logger = console } = {}) {
  const monitored = [...new Set(symbols)].slice(0, MAX_MONITORED_SYMBOLS);
  const monitoredSet = new Set(monitored);
  const gateSet = new Set(gateSymbols.filter((x)=>monitoredSet.has(x)));
  const kucoinSet = new Set(kucoinSymbols.filter((x)=>monitoredSet.has(x)));

  const books = {
    binance:new Map(),
    bybit:new Map(),
    okx:new Map(),
    gate:new Map(),
    kucoin:new Map(),
  };
  const status = {
    binance:{state:'idle',last:null,error:null},
    bybit:{state:'idle',last:null,error:null},
    okx:{state:'idle',last:null,error:null},
    gate:{state:'idle',last:null,error:null},
    kucoin:{state:'idle',last:null,error:null},
  };
  const diagnostics = {
    binanceFirstQuoteAt:null,
    bybitFirstQuoteAt:null,
    okxFirstQuoteAt:null,
    gateFirstQuoteAt:null,
    kucoinFirstQuoteAt:null,
    binanceSubscribedBatches:0,
    binanceSocketReconnects:0,
    binanceDiscoveredSymbols:0,
    binanceSubscribedSymbols:0,
    gateSubscribedBatches:0,
    gateSocketReconnects:0,
    bybitPollsOk:0,
    bybitPollsFailed:0,
    okxPollsOk:0,
    okxPollsFailed:0,
    kucoinPollsOk:0,
    kucoinPollsFailed:0,
    bybitLastPollCount:0,
    okxLastPollCount:0,
    kucoinLastPollCount:0,
    gateQuoteCount:0,
    bybitRestSource:null,
    okxRestSource:null,
    kucoinRestSource:null,
  };

  const binanceSockets = new Map();
  const gateSockets = new Map();
  const binanceReconnectTimers = new Map();
  const gateReconnectTimers = new Map();
  const binanceRetryCounts = new Map();
  const gateRetryCounts = new Map();
  const binanceKnownSymbols = new Set();
  const binanceSubscribedSymbols = new Set();
  const binanceSubscriptionQueue = new Set();
  const gateHeartbeatTimers = new Map();
  let binancePumpScheduled = false;
  const timers = new Set();
  let stopped = false;
  let bybitGeneration = 0;
  let okxGeneration = 0;
  let kucoinGeneration = 0;
  let kucoinNextPollMs = KUCOIN_POLL_MS;

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

  function storeBook(exchange, symbol, raw) {
    if (!symbol || !monitoredSet.has(symbol)) return false;
    const sourceTs = Number(raw?.ts);
    const ts = Number.isFinite(sourceTs) && sourceTs > 0 ? sourceTs : Date.now();
    const book = topBook({ ...raw, ts });
    if (!book) return false;
    books[exchange].set(symbol, book);
    touch(exchange, Date.now());
    return true;
  }

  function openSocketCount(map) {
    return [...map.values()].filter((ws)=>ws?.readyState===WebSocket.OPEN).length;
  }

  function clearReconnectMap(map) {
    for (const timer of map.values()) clearTimeout(timer);
    map.clear();
  }

  function closeSocketMap(map) {
    for (const ws of map.values()) {
      try {
        ws.onclose = null;
        ws.close();
      } catch {}
    }
    map.clear();
  }

  function clearGateHeartbeats() {
    for (const timer of gateHeartbeatTimers.values()) clearInterval(timer);
    gateHeartbeatTimers.clear();
  }

  function scheduleBinanceReconnect(kind, connect) {
    if (stopped || binanceReconnectTimers.has(kind)) return;
    const retry=(binanceRetryCounts.get(kind)||0)+1;
    binanceRetryCounts.set(kind,retry);
    diagnostics.binanceSocketReconnects += 1;
    const delay=Math.min(30_000,2_000*(2 ** Math.min(retry-1,4)));
    const timer=setTimeout(()=>{
      binanceReconnectTimers.delete(kind);
      connect();
    },delay);
    binanceReconnectTimers.set(kind,timer);
  }

  function queueBinanceSymbols(symbols) {
    for (const symbol of symbols) {
      if (!monitoredSet.has(symbol) || binanceSubscribedSymbols.has(symbol)) continue;
      binanceSubscriptionQueue.add(symbol);
    }
    diagnostics.binanceDiscoveredSymbols = binanceKnownSymbols.size;
    pumpBinanceSubscriptions();
  }

  function pumpBinanceSubscriptions() {
    if (stopped || binancePumpScheduled || !binanceSubscriptionQueue.size) return;
    const ws=binanceSockets.get('book');
    if (!ws || ws.readyState!==WebSocket.OPEN) return;

    binancePumpScheduled=true;
    const params=[...binanceSubscriptionQueue]
      .slice(0,BINANCE_SUBSCRIBE_CHUNK)
      .map((symbol)=>`${symbol.toLowerCase()}@bookTicker`);
    const symbols=params.map((stream)=>stream.slice(0,-'@bookTicker'.length).toUpperCase());

    try {
      ws.send(JSON.stringify({
        method:'SUBSCRIBE',
        params,
        id:Date.now()%2_000_000_000,
      }));
      for (const symbol of symbols) {
        binanceSubscriptionQueue.delete(symbol);
        binanceSubscribedSymbols.add(symbol);
      }
      diagnostics.binanceSubscribedSymbols=binanceSubscribedSymbols.size;
    } catch(error) {
      logger.warn('[market] Binance subscribe send falhou',error?.message||error);
    }

    later(()=>{
      binancePumpScheduled=false;
      pumpBinanceSubscriptions();
    },BINANCE_SUBSCRIBE_DELAY_MS);
  }

  function openBinanceBookSocket() {
    if (stopped) return;
    const previous=binanceSockets.get('book');
    if (previous) {
      try { previous.onclose=null; previous.close(); } catch {}
    }

    const ws=new WebSocket(BINANCE_WS);
    binanceSockets.set('book',ws);

    ws.onopen=()=>{
      logger.info('[market] Binance bookTicker WS conectado');
      binanceRetryCounts.set('book',0);
      binanceSubscribedSymbols.clear();
      diagnostics.binanceSubscribedSymbols=0;
      queueBinanceSymbols(binanceKnownSymbols);
    };

    ws.onerror=()=>{
      if (!books.binance.size) setStatus('binance','error','book_websocket_error');
    };

    ws.onclose=(event)=>{
      const heartbeat=gateHeartbeatTimers.get(socketIndex);
      if (heartbeat) clearInterval(heartbeat);
      gateHeartbeatTimers.delete(socketIndex);
      if (stopped) return;
      if (binanceSockets.get('book')===ws) binanceSockets.delete('book');
      logger.warn('[market] Binance bookTicker WS desconectado',event?.code);
      binanceSubscribedSymbols.clear();
      diagnostics.binanceSubscribedSymbols=0;
      for (const symbol of binanceKnownSymbols) binanceSubscriptionQueue.add(symbol);
      if (!books.binance.size) setStatus('binance','disconnected',`book_close_${event?.code ?? 'unknown'}`);
      scheduleBinanceReconnect('book',openBinanceBookSocket);
    };

    ws.onmessage=(event)=>{
      try {
        const msg=parseMessage(event);
        if (Object.hasOwn(msg||{},'result')&&Object.hasOwn(msg||{},'id')) {
          if (msg.result===null) diagnostics.binanceSubscribedBatches += 1;
          return;
        }
        if (msg?.code != null) {
          logger.warn('[market] Binance subscribe erro',msg.code,msg.msg||'');
          return;
        }
        const symbol=msg?.s;
        const ok=storeBook('binance',symbol,{
          bidPrice:msg.b,bidQty:msg.B,askPrice:msg.a,askQty:msg.A,
        });
        if (ok && !diagnostics.binanceFirstQuoteAt) {
          diagnostics.binanceFirstQuoteAt=Date.now();
          logger.info('[market] Binance primeira cotação',symbol);
        }
      } catch(error) {
        logger.warn('[market] Binance mensagem inválida',error?.message||error);
      }
    };
  }

  function openBinanceDiscoverySocket() {
    if (stopped) return;
    const previous=binanceSockets.get('discovery');
    if (previous) {
      try { previous.onclose=null; previous.close(); } catch {}
    }

    const ws=new WebSocket(BINANCE_DISCOVERY_WS);
    binanceSockets.set('discovery',ws);

    ws.onopen=()=>{
      logger.info('[market] Binance discovery WS conectado',BINANCE_DISCOVERY_STREAM);
      binanceRetryCounts.set('discovery',0);
    };

    ws.onerror=()=>{
      if (!books.binance.size) setStatus('binance','error','discovery_websocket_error');
    };

    ws.onclose=(event)=>{
      if (stopped) return;
      if (binanceSockets.get('discovery')===ws) binanceSockets.delete('discovery');
      logger.warn('[market] Binance discovery WS desconectado',event?.code);
      scheduleBinanceReconnect('discovery',openBinanceDiscoverySocket);
    };

    ws.onmessage=(event)=>{
      try {
        const payload=parseMessage(event);
        const discovered=selectDiscoveredBinanceSymbols(payload,monitoredSet);
        const fresh=[];
        for (const symbol of discovered) {
          if (!binanceKnownSymbols.has(symbol)) {
            binanceKnownSymbols.add(symbol);
            fresh.push(symbol);
          }
        }
        if (fresh.length) queueBinanceSymbols(fresh);
      } catch(error) {
        logger.warn('[market] Binance discovery mensagem inválida',error?.message||error);
      }
    };
  }

  function connectBinance() {
    if (stopped || !monitored.length) return;
    clearReconnectMap(binanceReconnectTimers);
    closeSocketMap(binanceSockets);
    binanceRetryCounts.clear();
    binanceKnownSymbols.clear();
    binanceSubscribedSymbols.clear();
    binanceSubscriptionQueue.clear();
    diagnostics.binanceDiscoveredSymbols=0;
    diagnostics.binanceSubscribedSymbols=0;
    setStatus('binance','connecting');
    openBinanceDiscoverySocket();
    later(openBinanceBookSocket,500);
  }

  async function fetchBybitSnapshot() {
    const result = await fetchFirstJson(
      BYBIT_REST_BASES,
      '/v5/market/tickers?category=spot',
      (data)=>data?.retCode === 0 && Array.isArray(data?.result?.list),
    );
    return {
      base:result.base,
      list:result.data.result.list,
      ts:Number(result.data?.time) || Date.now(),
    };
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
            ts:result.ts,
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
            ts:Number(raw?.ts) || Date.now(),
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

  async function fetchKucoinSnapshot() {
    const result = await fetchFirstJson(
      KUCOIN_REST_BASES,
      '/api/v1/market/allTickers',
      (data)=>data?.code === '200000' && Array.isArray(data?.data?.ticker),
    );
    return {
      base:result.base,
      list:result.data.data.ticker,
      ts:Number(result.data?.data?.time) || Date.now(),
    };
  }

  function connectKucoin() {
    if (stopped || !kucoinSet.size) {
      setStatus('kucoin','idle','no_symbols');
      return;
    }
    const generation = ++kucoinGeneration;
    setStatus('kucoin','connecting');

    const poll = async () => {
      if (stopped || generation !== kucoinGeneration) return;
      try {
        const result = await fetchKucoinSnapshot();
        let count = 0;
        for (const raw of result.list) {
          const pair = String(raw?.symbol || '');
          if (!pair.endsWith('-USDT')) continue;
          const symbol = canonicalSymbol(pair.slice(0,-5));
          if (!kucoinSet.has(symbol)) continue;
          if (storeBook('kucoin',symbol,{
            bidPrice:raw?.buy,bidQty:raw?.bestBidSize,
            askPrice:raw?.sell,askQty:raw?.bestAskSize,
            ts:result.ts,
          })) count += 1;
        }
        diagnostics.kucoinPollsOk += 1;
        diagnostics.kucoinLastPollCount = count;
        diagnostics.kucoinRestSource = result.base;
        kucoinNextPollMs = KUCOIN_POLL_MS;
        if (count > 0 && !diagnostics.kucoinFirstQuoteAt) {
          diagnostics.kucoinFirstQuoteAt = Date.now();
          logger.info('[market] KuCoin primeiro snapshot agregado',count,'pares');
        }
        if (count === 0) setStatus('kucoin','error','empty_ticker_snapshot');
      } catch (error) {
        diagnostics.kucoinPollsFailed += 1;
        setStatus('kucoin','error',error?.message || 'rest_poll_failed');
        const isRateLimit = String(error?.message || '').includes('HTTP 429');
        kucoinNextPollMs = isRateLimit
          ? Math.min(Math.max(kucoinNextPollMs * 2, 10_000), KUCOIN_MAX_BACKOFF_MS)
          : Math.min(Math.max(kucoinNextPollMs, KUCOIN_POLL_MS), 10_000);
        logger.warn('[market] KuCoin snapshot falhou',error?.message || error,'retry_ms',kucoinNextPollMs);
      } finally {
        if (!stopped && generation === kucoinGeneration) later(poll,kucoinNextPollMs);
      }
    };
    poll();
  }

  function scheduleGateReconnect(pairs, socketIndex, total) {
    if (stopped || gateReconnectTimers.has(socketIndex)) return;
    const retry=(gateRetryCounts.get(socketIndex)||0)+1;
    gateRetryCounts.set(socketIndex,retry);
    diagnostics.gateSocketReconnects += 1;
    const delay=Math.min(30_000,2_000*(2 ** Math.min(retry-1,4)))+socketIndex*250;
    const timer=setTimeout(()=>{
      gateReconnectTimers.delete(socketIndex);
      openGateSocket(pairs,socketIndex,total);
    },delay);
    gateReconnectTimers.set(socketIndex,timer);
  }

  function openGateSocket(pairs, socketIndex, total) {
    if (stopped || !pairs.length) return;
    const previous=gateSockets.get(socketIndex);
    if (previous) {
      try {
        previous.onclose=null;
        previous.close();
      } catch {}
    }

    const ws=new WebSocket(GATE_WS);
    gateSockets.set(socketIndex,ws);

    ws.onopen=()=>{
      logger.info('[market] Gate WS conectado',socketIndex+1,'/',total);
      const oldHeartbeat=gateHeartbeatTimers.get(socketIndex);
      if (oldHeartbeat) clearInterval(oldHeartbeat);
      gateHeartbeatTimers.set(socketIndex,setInterval(()=>{
        if (ws.readyState!==WebSocket.OPEN) return;
        try {
          ws.send(JSON.stringify({
            time:Math.floor(Date.now()/1000),
            channel:'spot.ping',
          }));
        } catch {}
      },GATE_HEARTBEAT_MS));
      chunkTopics(pairs,GATE_SUBSCRIBE_CHUNK).forEach((payload,index)=>{
        later(()=>{
          if (ws.readyState!==WebSocket.OPEN) return;
          ws.send(JSON.stringify({
            time:Math.floor(Date.now()/1000),
            channel:'spot.book_ticker',
            event:'subscribe',
            payload,
          }));
          diagnostics.gateSubscribedBatches += 1;
        },index*GATE_SUBSCRIBE_DELAY_MS);
      });
    };

    ws.onerror=()=>{
      if (openSocketCount(gateSockets)===0) setStatus('gate','error','websocket_error');
    };

    ws.onclose=(event)=>{
      if (stopped) return;
      if (gateSockets.get(socketIndex)===ws) gateSockets.delete(socketIndex);
      logger.warn('[market] Gate WS desconectado',socketIndex+1,event?.code);
      if (openSocketCount(gateSockets)===0) {
        setStatus('gate','disconnected',`close_${event?.code ?? 'unknown'}`);
      } else {
        status.gate={...status.gate,error:`partial_socket_${socketIndex+1}_down`};
      }
      scheduleGateReconnect(pairs,socketIndex,total);
    };

    ws.onmessage=(event)=>{
      try {
        const msg=parseMessage(event);
        if (msg?.channel==='spot.pong') return;
        if (msg?.channel!=='spot.book_ticker'||msg?.event!=='update') return;
        const raw=msg.result;
        const pair=String(raw?.s||'');
        if (!pair.endsWith('_USDT')) return;
        const symbol=canonicalSymbol(pair.slice(0,-5));
        const ok=storeBook('gate',symbol,{
          bidPrice:raw?.b,bidQty:raw?.B,
          askPrice:raw?.a,askQty:raw?.A,
          ts:Number(raw?.t)||Number(msg?.time_ms)||(Number(msg?.time)?Number(msg.time)*1000:Date.now()),
        });
        if (ok) {
          gateRetryCounts.set(socketIndex,0);
          diagnostics.gateQuoteCount += 1;
          if (!diagnostics.gateFirstQuoteAt) {
            diagnostics.gateFirstQuoteAt=Date.now();
            logger.info('[market] Gate primeira cotação',symbol);
          }
        }
      } catch(error) {
        logger.warn('[market] Gate mensagem inválida',error?.message||error);
      }
    };
  }

  function connectGate() {
    if (stopped || !gateSet.size) {
      setStatus('gate','idle','no_symbols');
      return;
    }
    clearReconnectMap(gateReconnectTimers);
    clearGateHeartbeats();
    closeSocketMap(gateSockets);
    gateRetryCounts.clear();
    setStatus('gate','connecting');

    const pairGroups=chunkTopics(
      [...gateSet].map((symbol)=>`${symbol.slice(0,-4)}_USDT`),
      GATE_PAIRS_PER_SOCKET,
    );
    pairGroups.forEach((pairs,index)=>{
      later(()=>openGateSocket(pairs,index,pairGroups.length),index*500);
    });
  }

  function start() {
    stopped = false;
    connectBinance();
    connectBybit();
    connectOkx();
    connectGate();
    connectKucoin();
  }

  function stop() {
    stopped = true;
    bybitGeneration += 1;
    okxGeneration += 1;
    kucoinGeneration += 1;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    clearReconnectMap(binanceReconnectTimers);
    clearReconnectMap(gateReconnectTimers);
    clearGateHeartbeats();
    closeSocketMap(binanceSockets);
    closeSocketMap(gateSockets);
  }

  function reconnect() {
    bybitGeneration += 1;
    okxGeneration += 1;
    kucoinGeneration += 1;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    clearReconnectMap(binanceReconnectTimers);
    clearReconnectMap(gateReconnectTimers);
    closeSocketMap(binanceSockets);
    closeSocketMap(gateSockets);
    later(()=>{
      if (!stopped) {
        connectBinance();
        connectBybit();
        connectOkx();
        connectGate();
        connectKucoin();
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
        kucoin:serialize(books.kucoin),
      },
    };
  }

  return { start, stop, reconnect, snapshot };
}
