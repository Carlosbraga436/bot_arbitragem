import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildMultiExchangeUniverse,
  createMarketHub,
  MAX_MONITORED_SYMBOLS,
  selectConfirmedSymbols,
} from './src/market-hub.js';
import { DEFAULT_COSTS, DEFAULT_RULES, evaluateAcrossExchanges } from './src/core.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8787);

const BYBIT_BASES = ['https://api.bybit.com','https://api.bytick.com'];
const OKX_BASES = ['https://www.okx.com','https://openapi.okx.com'];
const GATE_BASES = ['https://api.gateio.ws/api/v4'];
const KUCOIN_BASES = ['https://api.kucoin.com'];
const REQUEST_TIMEOUT_MS = 10_000;
const APP_VERSION = '0.19.0-recovery.1';

let runtimePromise = null;

function json(res, status, body) {
  res.writeHead(status, {
    'content-type':'application/json; charset=utf-8',
    'cache-control':'no-store',
  });
  res.end(JSON.stringify(body));
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(()=>controller.abort(),REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(url,{
      signal:controller.signal,
      headers:{'user-agent':`radar-cripto-carlos/${APP_VERSION}`},
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
    return await r.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchFirst(bases,path,validate=()=>true) {
  const errors=[];
  for (const base of bases) {
    try {
      const data=await fetchJson(`${base}${path}`);
      if (!validate(data)) throw new Error('invalid_response');
      return {base,data};
    } catch (error) {
      errors.push(`${base}: ${error?.message || error}`);
    }
  }
  throw new Error(errors.join(' | '));
}

async function fetchBybitSpotInstruments() {
  const items=[];
  let cursor='';
  let sourceBase=null;
  do {
    const suffix=cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
    const result=await fetchFirst(
      BYBIT_BASES,
      `/v5/market/instruments-info?category=spot&limit=1000${suffix}`,
      (data)=>data?.retCode===0 && Array.isArray(data?.result?.list),
    );
    sourceBase=result.base;
    items.push(...result.data.result.list);
    cursor=result.data?.result?.nextPageCursor || '';
  } while (cursor);
  return {base:sourceBase,items};
}

async function fetchOkxSpotInstruments() {
  const result=await fetchFirst(
    OKX_BASES,
    '/api/v5/public/instruments?instType=SPOT',
    (data)=>data?.code==='0' && Array.isArray(data?.data),
  );
  return {base:result.base,items:result.data.data};
}

async function fetchGateSpotPairs() {
  const result=await fetchFirst(
    GATE_BASES,
    '/spot/currency_pairs',
    (data)=>Array.isArray(data),
  );
  return {base:result.base,items:result.data};
}

async function fetchKucoinSpotInstruments() {
  const result=await fetchFirst(
    KUCOIN_BASES,
    '/api/ua/v2/market/instrument?tradeType=SPOT',
    (data)=>data?.code==='200000' && Array.isArray(data?.data?.list),
  );
  return {base:result.base,items:result.data.data.list};
}

async function getCatalog() {
  const [bybitResult,okxResult,gateResult,kucoinResult]=await Promise.all([
    fetchBybitSpotInstruments(),
    fetchOkxSpotInstruments(),
    fetchGateSpotPairs(),
    fetchKucoinSpotInstruments(),
  ]);

  const candidates=buildMultiExchangeUniverse({
    bybitSymbols:bybitResult.items,
    okxSymbols:okxResult.items,
    gateSymbols:gateResult.items,
    kucoinSymbols:kucoinResult.items,
  });
  const monitoredSymbols=selectConfirmedSymbols(candidates,MAX_MONITORED_SYMBOLS);
  const monitoredSet=new Set(monitoredSymbols);

  const gateSymbols=candidates
    .filter((x)=>monitoredSet.has(x.symbol) && x?.venues?.gate)
    .map((x)=>x.symbol);
  const kucoinSymbols=candidates
    .filter((x)=>monitoredSet.has(x.symbol) && x?.venues?.kucoin)
    .map((x)=>x.symbol);

  const countVenue=(venue)=>candidates.filter((x)=>x?.venues?.[venue]).length;

  return {
    generatedAt:Date.now(),
    version:APP_VERSION,
    sources:{
      binance:'live_websocket_probe',
      bybit:bybitResult.base,
      okx:okxResult.base,
      gate:gateResult.base,
      kucoin:kucoinResult.base,
    },
    universeMode:'union_of_public_USDT_catalogs+live_books',
    maxMonitored:MAX_MONITORED_SYMBOLS,
    exchangeUniverse:{
      binanceActiveUsdt:null,
      bybitActiveUsdt:countVenue('bybit'),
      okxActiveUsdt:countVenue('okx'),
      gateActiveUsdt:countVenue('gate'),
      kucoinActiveUsdt:countVenue('kucoin'),
      candidateUsdt:candidates.length,
    },
    candidates,
    monitoredSymbols,
    gateSymbols,
    kucoinSymbols,
    confirmed:candidates.length,
    pending:0,
  };
}

async function ensureRuntime() {
  if (!runtimePromise) {
    runtimePromise=(async()=>{
      const catalog=await getCatalog();
      if (!catalog.monitoredSymbols.length) {
        throw new Error('Nenhum mercado spot USDT encontrado para monitoramento.');
      }

      const marketHub=createMarketHub({
        symbols:catalog.monitoredSymbols,
        gateSymbols:catalog.gateSymbols,
        kucoinSymbols:catalog.kucoinSymbols,
      });
      marketHub.start();

      console.log(
        `[catalog] ${catalog.exchangeUniverse.candidateUsdt} candidatos USDT; monitorando ${catalog.monitoredSymbols.length}; Gate ${catalog.gateSymbols.length}; KuCoin ${catalog.kucoinSymbols.length}`
      );

      const runtime={catalog,marketHub};
      setTimeout(()=>{
        try {
          for (const budget of [100,500,1000]) {
            console.log(`[diagnostics-${budget}]`,JSON.stringify(marketDiagnostics(runtime,budget)));
          }
        } catch (error) {
          console.warn('[diagnostics] falhou:',error?.message || error);
        }
      },15_000);

      return runtime;
    })().catch((error)=>{
      runtimePromise=null;
      throw error;
    });
  }
  return runtimePromise;
}

function marketDiagnostics(runtime,budgetUsdt=100) {
  const snap=runtime.marketHub.snapshot();
  const bySymbol=new Map(runtime.catalog.candidates.map((x)=>[x.symbol,x]));
  const now=Date.now();
  const exchanges=Object.keys(snap.books);

  const results=snap.symbols.map((symbol)=>{
    const asset=bySymbol.get(symbol);
    const booksByExchange=Object.fromEntries(
      exchanges
        .map((exchange)=>[exchange,snap.books[exchange]?.[symbol]])
        .filter(([,book])=>book)
    );
    const costs={
      ...DEFAULT_COSTS,
      exchangeFeePct:{
        ...DEFAULT_COSTS.exchangeFeePct,
        ...(asset?.feePctByExchange || {}),
      },
    };
    return evaluateAcrossExchanges({
      symbol,
      identityConfirmed:Boolean(asset?.identityConfirmed),
      booksByExchange,
      budgetUsdt,
      costs,
      rules:DEFAULT_RULES,
      now,
    });
  });

  const reasonCounts={};
  for (const r of results) reasonCounts[r.reason]=(reasonCounts[r.reason]||0)+1;

  const finite=results.filter((r)=>Number.isFinite(r.netPnlUsdt));
  const topGross=[...finite].sort((a,b)=>(b.grossPnlUsdt??-Infinity)-(a.grossPnlUsdt??-Infinity))[0]||null;
  const topNet=[...finite].sort((a,b)=>(b.netPnlUsdt??-Infinity)-(a.netPnlUsdt??-Infinity))[0]||null;

  return {
    generatedAt:now,
    budgetUsdt,
    monitored:snap.symbols.length,
    exchangeBooks:Object.fromEntries(
      exchanges.map((exchange)=>[exchange,Object.keys(snap.books[exchange]||{}).length])
    ),
    pairsWith2PlusVenues:snap.symbols.filter((symbol)=>
      exchanges.filter((exchange)=>Boolean(snap.books[exchange]?.[symbol])).length>=2
    ).length,
    finiteResults:finite.length,
    positiveNet:finite.filter((r)=>r.netPnlUsdt>0).length,
    reasonCounts,
    topGross:topGross ? {
      symbol:topGross.symbol,
      buyExchange:topGross.buyExchange,
      sellExchange:topGross.sellExchange,
      grossPnlUsdt:topGross.grossPnlUsdt,
      grossPctOnBuy:(topGross.grossPnlUsdt/budgetUsdt)*100,
      netPnlUsdt:topGross.netPnlUsdt,
    }:null,
    topNet:topNet ? {
      symbol:topNet.symbol,
      buyExchange:topNet.buyExchange,
      sellExchange:topNet.sellExchange,
      grossPnlUsdt:topNet.grossPnlUsdt,
      netPnlUsdt:topNet.netPnlUsdt,
      netPctOnBuy:topNet.netPctOnBuy,
    }:null,
    modeledCosts:DEFAULT_COSTS,
  };
}

async function serveStatic(pathname,res) {
  const rel=pathname==='/'?'index.html':pathname.replace(/^\/+/, '');
  const safe=normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '');
  const path=join(PUBLIC,safe);
  if (!path.startsWith(PUBLIC)) return json(res,403,{error:'forbidden'});

  try {
    const info=await stat(path);
    if (!info.isFile()) throw new Error('not file');
    const data=await readFile(path);
    const type={
      '.html':'text/html; charset=utf-8',
      '.js':'text/javascript; charset=utf-8',
      '.css':'text/css; charset=utf-8',
    }[extname(path)] || 'application/octet-stream';
    res.writeHead(200,{'content-type':type,'cache-control':'no-store'});
    res.end(data);
  } catch {
    json(res,404,{error:'not_found'});
  }
}

const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,`http://${req.headers.host || 'localhost'}`);

  try {
    if (url.pathname==='/api/health') {
      return json(res,200,{
        ok:true,
        mode:'simulation-only',
        ordersEnabled:false,
        version:APP_VERSION,
        exchanges:['binance','bybit','okx','gate','kucoin'],
      });
    }

    if (url.pathname==='/api/catalog') {
      const {catalog}=await ensureRuntime();
      return json(res,200,catalog);
    }

    if (url.pathname==='/api/market') {
      const {marketHub}=await ensureRuntime();
      return json(res,200,marketHub.snapshot());
    }

    if (url.pathname==='/api/diagnostics') {
      const runtime=await ensureRuntime();
      const budget=Number(url.searchParams.get('budget')||100);
      return json(res,200,marketDiagnostics(runtime,Number.isFinite(budget)&&budget>0?budget:100));
    }

    if (url.pathname==='/api/reconnect' && req.method==='POST') {
      const {marketHub}=await ensureRuntime();
      marketHub.reconnect();
      return json(res,202,{ok:true,message:'reconnect_requested'});
    }

    if (url.pathname==='/api/reference') {
      const {catalog}=await ensureRuntime();
      return json(res,200,{
        mode:'public-market-data-only',
        version:APP_VERSION,
        universeMode:catalog.universeMode,
        sources:catalog.sources,
        exchanges:['binance','bybit','okx','gate','kucoin'],
        feeModel:DEFAULT_COSTS,
        monitoredCount:catalog.monitoredSymbols.length,
        candidateUsdt:catalog.exchangeUniverse.candidateUsdt,
      });
    }

    if (url.pathname==='/src/core.js') {
      const data=await readFile(join(ROOT,'src','core.js'));
      res.writeHead(200,{
        'content-type':'text/javascript; charset=utf-8',
        'cache-control':'no-store',
      });
      return res.end(data);
    }

    return await serveStatic(url.pathname,res);
  } catch(error) {
    return json(res,502,{
      error:'upstream_unavailable',
      message:error?.message || String(error),
    });
  }
});

for (const signal of ['SIGTERM','SIGINT']) {
  process.on(signal,()=>{
    Promise.resolve(runtimePromise)
      .then((runtime)=>runtime?.marketHub?.stop())
      .catch(()=>{})
      .finally(()=>server.close(()=>process.exit(0)));
  });
}

server.listen(PORT,'0.0.0.0',()=>{
  console.log(`Radar Cripto ${APP_VERSION} em 0.0.0.0:${PORT}`);
  ensureRuntime().catch((error)=>{
    console.warn('[runtime] inicialização falhou:',error?.message || error);
  });
});
