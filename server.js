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
import {
  DEFAULT_COSTS,
  DEFAULT_RULES,
  evaluateAcrossExchanges,
  exchangeFeePct,
  topPositive,
} from './src/core.js';
import { buildDexRadar, dexRegistrySnapshot } from './src/dex-radar.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8787);

const BYBIT_BASES = ['https://api.bybit.com','https://api.bytick.com'];
const OKX_BASES = ['https://www.okx.com','https://openapi.okx.com'];
const GATE_BASES = ['https://api.gateio.ws/api/v4'];
const KUCOIN_BASES = ['https://api.kucoin.com'];
const BITGET_BASES = ['https://api.bitget.com'];
const HTX_BASES = ['https://api.huobi.pro','https://api-aws.huobi.pro'];
const REQUEST_TIMEOUT_MS = 10_000;
const APP_VERSION = '0.24.0-recovery.1';
const RADAR_CACHE_MS = 750;

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

async function fetchBitgetSpotInstruments() {
  const result=await fetchFirst(
    BITGET_BASES,
    '/api/v3/market/instruments?category=SPOT',
    (data)=>data?.code==='00000' && Array.isArray(data?.data),
  );
  return {base:result.base,items:result.data.data};
}

async function fetchHtxSpotInstruments() {
  try {
    const result=await fetchFirst(
      HTX_BASES,
      '/v1/settings/common/market-symbols?symbols=NA',
      (data)=>data?.status==='ok' && Array.isArray(data?.data),
    );
    return {base:result.base,items:result.data};
  } catch (primaryError) {
    const fallback=await fetchFirst(
      HTX_BASES,
      '/v1/common/symbols',
      (data)=>data?.status==='ok' && Array.isArray(data?.data),
    );
    return {base:fallback.base,items:fallback.data.data,fallback:true,primaryError:primaryError?.message||String(primaryError)};
  }
}

async function getCatalog() {
  const [bybitResult,okxResult,gateResult,kucoinResult,bitgetResult,htxResult]=await Promise.all([
    fetchBybitSpotInstruments(),
    fetchOkxSpotInstruments(),
    fetchGateSpotPairs(),
    fetchKucoinSpotInstruments(),
    fetchBitgetSpotInstruments(),
    fetchHtxSpotInstruments(),
  ]);

  const candidates=buildMultiExchangeUniverse({
    bybitSymbols:bybitResult.items,
    okxSymbols:okxResult.items,
    gateSymbols:gateResult.items,
    kucoinSymbols:kucoinResult.items,
    bitgetSymbols:bitgetResult.items,
    htxSymbols:htxResult.items,
  });
  const monitoredSymbols=selectConfirmedSymbols(candidates,MAX_MONITORED_SYMBOLS);
  const monitoredSet=new Set(monitoredSymbols);

  const gateSymbols=candidates
    .filter((x)=>monitoredSet.has(x.symbol) && x?.venues?.gate)
    .map((x)=>x.symbol);
  const kucoinSymbols=candidates
    .filter((x)=>monitoredSet.has(x.symbol) && x?.venues?.kucoin)
    .map((x)=>x.symbol);
  const bitgetSymbols=candidates
    .filter((x)=>monitoredSet.has(x.symbol) && x?.venues?.bitget)
    .map((x)=>x.symbol);
  const htxSymbols=candidates
    .filter((x)=>monitoredSet.has(x.symbol) && x?.venues?.htx)
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
      bitget:bitgetResult.base,
      htx:htxResult.base,
    },
    universeMode:'union_of_public_USDT_catalogs+live_books',
    maxMonitored:MAX_MONITORED_SYMBOLS,
    exchangeUniverse:{
      binanceActiveUsdt:null,
      bybitActiveUsdt:countVenue('bybit'),
      okxActiveUsdt:countVenue('okx'),
      gateActiveUsdt:countVenue('gate'),
      kucoinActiveUsdt:countVenue('kucoin'),
      bitgetActiveUsdt:countVenue('bitget'),
      htxActiveUsdt:countVenue('htx'),
      candidateUsdt:candidates.length,
    },
    candidates,
    monitoredSymbols,
    gateSymbols,
    kucoinSymbols,
    bitgetSymbols,
    htxSymbols,
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
        bitgetSymbols:catalog.bitgetSymbols,
        htxSymbols:catalog.htxSymbols,
      });
      marketHub.start();

      console.log(
        `[catalog] ${catalog.exchangeUniverse.candidateUsdt} candidatos USDT; monitorando ${catalog.monitoredSymbols.length}; Gate ${catalog.gateSymbols.length}; KuCoin ${catalog.kucoinSymbols.length}; Bitget ${catalog.bitgetSymbols.length}; HTX ${catalog.htxSymbols.length}`
      );

      const runtime={
        catalog,
        marketHub,
        bySymbol:new Map(catalog.candidates.map((x)=>[x.symbol,x])),
        radarCache:new Map(),
        dexRadarCache:new Map(),
        dexRadarInFlight:new Map(),
      };

      setTimeout(()=>{
        try {
          for (const budget of [100,500,1000]) {
            console.log(`[diagnostics-${budget}]`,JSON.stringify(marketDiagnostics(runtime,budget)));
          }
        } catch (error) {
          console.warn('[diagnostics] falhou:',error?.message || error);
        }
      },15_000);

      setTimeout(async()=>{
        try {
          const dex=await dexRadarSnapshot(runtime,100);
          console.log('[dex-diagnostics-100]',JSON.stringify({
            version:dex.version,
            mode:dex.mode,
            registryAssets:dex.registryAssets,
            manualRegistryAssets:dex.manualRegistryAssets,
            autoVerifiedAssets:dex.autoVerifiedAssets,
            autoAllowlistCandidates:dex.autoAllowlistCandidates,
            poolIdentities:dex.poolIdentities,
            poolsFound:dex.poolsFound,
            maxPoolsPerAsset:dex.maxPoolsPerAsset,
            coverageByChain:dex.coverageByChain,
            directDex:dex.directDex,
            lifiDexTools:dex.lifiDexTools,
            funnel:dex.funnel,
            preliminaryCount:dex.preliminaryCount,
            preliminaryTop5:dex.preliminaryTop5,
            confirmedCount:dex.confirmedCount,
            depthConfirmedCount:dex.depthConfirmedCount,
            transferVerifiedCount:dex.transferVerifiedCount,
            positiveCount:dex.positiveCount,
            top5:dex.top5,
            nearest5:dex.nearest5,
            errors:dex.errors,
          }));
        } catch (error) {
          console.warn('[dex-diagnostics] falhou:',error?.message || error);
        }
      },25_000);

      return runtime;
    })().catch((error)=>{
      runtimePromise=null;
      throw error;
    });
  }
  return runtimePromise;
}

function costsForAsset(asset) {
  return {
    ...DEFAULT_COSTS,
    exchangeFeePct:{
      ...DEFAULT_COSTS.exchangeFeePct,
      ...(asset?.feePctByExchange || {}),
    },
  };
}

function venueQuotesForSymbol(booksByExchange,now=Date.now()) {
  const rows=Object.entries(booksByExchange||{}).map(([exchange,book])=>{
    const bid=Number(book?.bids?.[0]?.[0]);
    const ask=Number(book?.asks?.[0]?.[0]);
    const bidQty=Number(book?.bids?.[0]?.[1]);
    const askQty=Number(book?.asks?.[0]?.[1]);
    const ts=Number(book?.ts);
    if (!(bid>0) || !(ask>0) || !(bidQty>0) || !(askQty>0) || !Number.isFinite(ts)) return null;
    return {
      exchange,
      bid,
      ask,
      mid:(bid+ask)/2,
      bidQty,
      askQty,
      ts,
      ageMs:Math.max(0,now-ts),
    };
  }).filter(Boolean);
  const minAsk=rows.reduce((best,row)=>row.ask<(best?.ask??Infinity)?row:best,null);
  const maxBid=rows.reduce((best,row)=>row.bid>(best?.bid??-Infinity)?row:best,null);
  return rows.map((row)=>({
    ...row,
    bestBuy:row.exchange===minAsk?.exchange,
    bestSell:row.exchange===maxBid?.exchange,
  }));
}

function evaluateRuntime(runtime,budgetUsdt=100) {
  const snap=runtime.marketHub.snapshot();
  const now=Date.now();
  const exchanges=Object.keys(snap.books);

  const results=snap.symbols.map((symbol)=>{
    const asset=runtime.bySymbol.get(symbol);
    const booksByExchange=Object.fromEntries(
      exchanges
        .map((exchange)=>[exchange,snap.books[exchange]?.[symbol]])
        .filter(([,book])=>book)
    );
    const costs=costsForAsset(asset);
    const result=evaluateAcrossExchanges({
      symbol,
      identityConfirmed:Boolean(asset?.identityConfirmed),
      booksByExchange,
      budgetUsdt,
      costs,
      rules:DEFAULT_RULES,
      now,
    });
    result.venueQuotes=venueQuotesForSymbol(booksByExchange,now);

    if (Number.isFinite(result?.netPnlUsdt) && result?.buyExchange && result?.sellExchange) {
      result.breakEvenPct=
        exchangeFeePct(result.buyExchange,costs)
        + exchangeFeePct(result.sellExchange,costs)
        + (costs.reservePct*2);
      result.breakEvenAfterRebalancePct=
        result.breakEvenPct
        + ((costs.recompositionUsdt/result.budgetUsdt)*100);
    }
    return result;
  });

  const exchangeBooks=Object.fromEntries(
    exchanges.map((exchange)=>[exchange,Object.keys(snap.books[exchange]||{}).length])
  );
  const pairsWith2PlusVenues=snap.symbols.filter((symbol)=>
    exchanges.filter((exchange)=>Boolean(snap.books[exchange]?.[symbol])).length>=2
  ).length;

  return {snap,now,exchanges,results,exchangeBooks,pairsWith2PlusVenues};
}

function radarSnapshot(runtime,budgetUsdt=100) {
  const budget=Number.isFinite(Number(budgetUsdt)) && Number(budgetUsdt)>0
    ? Number(budgetUsdt)
    : 100;
  const cached=runtime.radarCache.get(budget);
  if (cached && Date.now()-cached.generatedAt<RADAR_CACHE_MS) return cached;

  const evaluated=evaluateRuntime(runtime,budget);
  const finite=evaluated.results.filter((r)=>Number.isFinite(r?.netPnlUsdt));
  const allPositives=evaluated.results
    .filter((r)=>r?.eligible && Number.isFinite(r?.netPnlUsdt) && r.netPnlUsdt>0);
  const positives=topPositive(allPositives,5);
  const nearest=[...finite]
    .filter((r)=>!r?.eligible)
    .sort((a,b)=>(b.netPnlUsdt??-Infinity)-(a.netPnlUsdt??-Infinity))
    .slice(0,5);

  const reasonCounts={};
  for (const r of evaluated.results) {
    reasonCounts[r.reason]=(reasonCounts[r.reason]||0)+1;
  }

  const body={
    generatedAt:Date.now(),
    version:APP_VERSION,
    budgetUsdt:budget,
    status:evaluated.snap.status,
    monitored:evaluated.snap.symbols.length,
    candidateUsdt:runtime.catalog.exchangeUniverse.candidateUsdt,
    exchangeBooks:evaluated.exchangeBooks,
    pairsWith2PlusVenues:evaluated.pairsWith2PlusVenues,
    liquidResults:finite.length,
    positiveNet:allPositives.length,
    top5:positives,
    nearest5:nearest,
    reasonCounts,
    safety:{
      simulationOnly:true,
      ordersEnabled:false,
      transferabilityVerified:false,
      anomalyGuardPct:DEFAULT_RULES.maxUnverifiedGrossSpreadPct,
      venueDeviationGuardPct:DEFAULT_RULES.maxVenueDeviationPct,
    },
  };

  runtime.radarCache.set(budget,body);
  return body;
}

async function dexRadarSnapshot(runtime,budgetUsdt=100) {
  const budget=Number.isFinite(Number(budgetUsdt)) && Number(budgetUsdt)>0
    ? Number(budgetUsdt)
    : 100;
  const cached=runtime.dexRadarCache.get(budget);
  if (cached && Date.now()-cached.generatedAt<15_000) return cached;

  if (runtime.dexRadarInFlight.has(budget)) {
    return runtime.dexRadarInFlight.get(budget);
  }

  const promise=buildDexRadar({
    snapshot:runtime.marketHub.snapshot(),
    budgetUsdt:budget,
    costsForSymbol:(symbol)=>costsForAsset(runtime.bySymbol.get(symbol)),
  }).then((body)=>({
    ...body,
    version:APP_VERSION,
    budgetUsdt:budget,
  })).then((body)=>{
    runtime.dexRadarCache.set(budget,body);
    return body;
  }).finally(()=>{
    runtime.dexRadarInFlight.delete(budget);
  });

  runtime.dexRadarInFlight.set(budget,promise);
  return promise;
}

function marketDiagnostics(runtime,budgetUsdt=100) {
  const radar=radarSnapshot(runtime,budgetUsdt);
  const candidates=[...radar.top5,...radar.nearest5];
  const topGross=[...candidates]
    .filter((r)=>Number.isFinite(r?.grossPnlUsdt))
    .sort((a,b)=>(b.grossPnlUsdt??-Infinity)-(a.grossPnlUsdt??-Infinity))[0]||null;
  const topNet=[...candidates]
    .filter((r)=>Number.isFinite(r?.netPnlUsdt))
    .sort((a,b)=>(b.netPnlUsdt??-Infinity)-(a.netPnlUsdt??-Infinity))[0]||null;

  return {
    generatedAt:radar.generatedAt,
    budgetUsdt:radar.budgetUsdt,
    monitored:radar.monitored,
    exchangeBooks:radar.exchangeBooks,
    pairsWith2PlusVenues:radar.pairsWith2PlusVenues,
    finiteResults:radar.liquidResults,
    positiveNet:radar.positiveNet,
    reasonCounts:radar.reasonCounts,
    topGross:topGross ? {
      symbol:topGross.symbol,
      buyExchange:topGross.buyExchange,
      sellExchange:topGross.sellExchange,
      grossPnlUsdt:topGross.grossPnlUsdt,
      grossPctOnBuy:topGross.grossSpreadPct,
      netPnlUsdt:topGross.netPnlUsdt,
    }:null,
    topNet:topNet ? {
      symbol:topNet.symbol,
      buyExchange:topNet.buyExchange,
      sellExchange:topNet.sellExchange,
      grossPnlUsdt:topNet.grossPnlUsdt,
      netPnlUsdt:topNet.netPnlUsdt,
      netPctOnBuy:topNet.netPctOnBuy,
      requestedBudgetUsdt:topNet.requestedBudgetUsdt,
      executableBudgetUsdt:topNet.executableBudgetUsdt,
      liquidityLimited:topNet.liquidityLimited,
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
        exchanges:['binance','bybit','okx','gate','kucoin','bitget','htx'],
        dexRadar:{
          enabled:true,
          mode:'same-chain-read-only',
          identity:'explicit_cex_mapping+chainId+exact_contract; auto requires Uniswap-list+LI.FI contract agreement',
          directQuotes:'read-only eth_call first for supported DEXs; LI.FI fallback',
        },
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

    if (url.pathname==='/api/radar') {
      const runtime=await ensureRuntime();
      const budget=Number(url.searchParams.get('budget')||100);
      return json(res,200,radarSnapshot(runtime,budget));
    }

    if (url.pathname==='/api/dex-radar') {
      const runtime=await ensureRuntime();
      const budget=Number(url.searchParams.get('budget')||100);
      return json(res,200,await dexRadarSnapshot(runtime,budget));
    }

    if (url.pathname==='/api/dex-registry') {
      await ensureRuntime();
      return json(res,200,{
        version:APP_VERSION,
        identityPolicy:'explicit CEX mapping + chainId + exact contract; automatic identities require Uniswap token list and LI.FI exact-contract agreement',
        assets:dexRegistrySnapshot(),
      });
    }

    if (url.pathname==='/api/diagnostics') {
      const runtime=await ensureRuntime();
      const budget=Number(url.searchParams.get('budget')||100);
      return json(res,200,marketDiagnostics(runtime,budget));
    }

    if (url.pathname==='/api/reconnect' && req.method==='POST') {
      const {marketHub,radarCache,dexRadarCache}=await ensureRuntime();
      radarCache.clear();
      dexRadarCache.clear();
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
        exchanges:['binance','bybit','okx','gate','kucoin','bitget','htx'],
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
