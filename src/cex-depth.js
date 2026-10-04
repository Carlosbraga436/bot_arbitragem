const DEFAULT_TIMEOUT_MS = 6_000;

function normalizeLevels(levels) {
  if (!Array.isArray(levels)) return [];
  return levels
    .map((level)=>[Number(level?.[0]),Number(level?.[1])])
    .filter(([price,qty])=>Number.isFinite(price)&&price>0&&Number.isFinite(qty)&&qty>0);
}

async function fetchJson(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try {
    const r=await fetch(url,{
      signal:controller.signal,
      headers:{'user-agent':'radar-cripto-carlos-depth/0.21'},
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFirst(urls, parser) {
  const errors=[];
  for (const url of urls) {
    try {
      const data=await fetchJson(url);
      const parsed=parser(data);
      if (!parsed?.bids?.length || !parsed?.asks?.length) throw new Error('empty_depth');
      return {...parsed,source:url};
    } catch(error) {
      errors.push(`${url}: ${error?.message||error}`);
    }
  }
  throw new Error(errors.join(' | '));
}

export function cexSymbolFormat(exchange, symbol) {
  const s=String(symbol||'').toUpperCase();
  if (!s.endsWith('USDT')) return null;
  const base=s.slice(0,-4);
  if (exchange==='okx' || exchange==='kucoin') return `${base}-USDT`;
  if (exchange==='gate') return `${base}_USDT`;
  return s;
}

export function depthCapacity(book) {
  const bids=normalizeLevels(book?.bids);
  const asks=normalizeLevels(book?.asks);
  return {
    bidBase:bids.reduce((sum,[,qty])=>sum+qty,0),
    bidQuote:bids.reduce((sum,[price,qty])=>sum+price*qty,0),
    askBase:asks.reduce((sum,[,qty])=>sum+qty,0),
    askQuote:asks.reduce((sum,[price,qty])=>sum+price*qty,0),
  };
}

export async function fetchCexDepth(exchange, symbol, limit = 100) {
  const ex=String(exchange||'').toLowerCase();
  const formatted=cexSymbolFormat(ex,symbol);
  if (!formatted) throw new Error('unsupported_symbol');

  if (ex==='binance') {
    const lim=Math.min(100,Math.max(5,Number(limit)||100));
    const urls=[
      `https://data-api.binance.vision/api/v3/depth?symbol=${encodeURIComponent(formatted)}&limit=${lim}`,
      `https://api.binance.com/api/v3/depth?symbol=${encodeURIComponent(formatted)}&limit=${lim}`,
      `https://api1.binance.com/api/v3/depth?symbol=${encodeURIComponent(formatted)}&limit=${lim}`,
      `https://api2.binance.com/api/v3/depth?symbol=${encodeURIComponent(formatted)}&limit=${lim}`,
    ];
    return fetchFirst(urls,(data)=>({
      exchange:ex,
      symbol,
      bids:normalizeLevels(data?.bids),
      asks:normalizeLevels(data?.asks),
      ts:Date.now(),
      updateId:data?.lastUpdateId??null,
      levels:lim,
    }));
  }

  if (ex==='bybit') {
    const lim=Math.min(200,Math.max(1,Number(limit)||100));
    const path=`/v5/market/orderbook?category=spot&symbol=${encodeURIComponent(formatted)}&limit=${lim}`;
    const urls=[`https://api.bybit.com${path}`,`https://api.bytick.com${path}`];
    return fetchFirst(urls,(data)=>({
      exchange:ex,
      symbol,
      bids:normalizeLevels(data?.result?.b),
      asks:normalizeLevels(data?.result?.a),
      ts:Number(data?.result?.ts)||Number(data?.time)||Date.now(),
      updateId:data?.result?.u??null,
      levels:lim,
    }));
  }

  if (ex==='okx') {
    const lim=Math.min(400,Math.max(1,Number(limit)||100));
    const urls=[
      `https://www.okx.com/api/v5/market/books?instId=${encodeURIComponent(formatted)}&sz=${lim}`,
      `https://www.okx.com/api/v5/market/books-rpi?instId=${encodeURIComponent(formatted)}&sz=${lim}`,
    ];
    return fetchFirst(urls,(data)=>{
      const row=data?.data?.[0];
      return {
        exchange:ex,
        symbol,
        bids:normalizeLevels(row?.bids),
        asks:normalizeLevels(row?.asks),
        ts:Number(row?.ts)||Date.now(),
        updateId:row?.seqId??null,
        levels:lim,
      };
    });
  }

  if (ex==='gate') {
    const lim=Math.min(100,Math.max(1,Number(limit)||100));
    const url=`https://api.gateio.ws/api/v4/spot/order_book?currency_pair=${encodeURIComponent(formatted)}&limit=${lim}&with_id=true`;
    return fetchFirst([url],(data)=>({
      exchange:ex,
      symbol,
      bids:normalizeLevels(data?.bids),
      asks:normalizeLevels(data?.asks),
      ts:Number(data?.current)||Date.now(),
      updateId:data?.id??null,
      levels:lim,
    }));
  }

  if (ex==='kucoin') {
    const size=Number(limit)>=100?100:20;
    const url=`https://api.kucoin.com/api/v1/market/orderbook/level2_${size}?symbol=${encodeURIComponent(formatted)}`;
    return fetchFirst([url],(data)=>({
      exchange:ex,
      symbol,
      bids:normalizeLevels(data?.data?.bids),
      asks:normalizeLevels(data?.data?.asks),
      ts:Number(data?.data?.time)||Date.now(),
      updateId:data?.data?.sequence??null,
      levels:size,
    }));
  }

  throw new Error(`unsupported_exchange:${ex}`);
}
