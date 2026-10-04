import { consumeBase, consumeQuote, exchangeFeePct } from './core.js';
import {
  CURATED_DEX_NAMES,
  CURATED_DEX_ID_ALIASES,
  DEX_ASSET_REGISTRY,
  chainForAsset,
  exactIdentityKey,
  isCuratedDexId,
  normalizeAddress,
  validateRegistry,
} from './dex-registry.js';

const DEXSCREENER_BASE = 'https://api.dexscreener.com';
const LIFI_BASE = 'https://li.quest/v1';
const READ_ONLY_ADDRESS = '0x0000000000000000000000000000000000000001';

const POOL_CACHE_MS = 30_000;
const TOOL_CACHE_MS = 10 * 60_000;
const TOKEN_CACHE_MS = 10 * 60_000;
const QUOTE_CACHE_MS = 120_000;
const MIN_POOL_LIQUIDITY_USD = 250_000;
const MIN_PRELIMINARY_SPREAD_PCT = 0.25;
const MAX_CONFIRMED_CANDIDATES = 1;
const MIN_CONFIRM_SPREAD_PCT = 0.50;
const LIFI_SLIPPAGE = 0.005;
const LIFI_TOOL_FALLBACK = Object.freeze([
  'uniswap',
  'sushiswap',
  'curve',
  'balancer',
  'pancakeswap',
  'camelot',
]);

const state = {
  poolsByIdentity: new Map(),
  poolFetchedAt: 0,
  toolKeys: [],
  toolsFetchedAt: 0,
  tokenMetaByIdentity: new Map(),
  tokensFetchedAt: 0,
  quoteCache: new Map(),
};

function finitePositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function pow10(decimals) {
  return 10n ** BigInt(decimals);
}

function decimalToUnits(value, decimals) {
  const n = finitePositive(value);
  if (!n) return null;
  const scale = 10 ** Math.min(decimals, 12);
  const rounded = Math.floor(n * scale);
  return BigInt(rounded) * (10n ** BigInt(Math.max(0, decimals - 12))) * (decimals <= 12 ? 1n : 1n)
    / BigInt(decimals <= 12 ? scale / (10 ** decimals) : 1);
}

function numberToUnits(value, decimals) {
  const n = finitePositive(value);
  if (!n) return null;
  const fixed = n.toFixed(Math.min(decimals, 12));
  const [whole, frac=''] = fixed.split('.');
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole) * pow10(decimals) + BigInt(padded || '0');
}

function unitsToNumber(value, decimals) {
  if (value == null) return null;
  try {
    const raw = BigInt(String(value));
    const div = Number(pow10(decimals));
    if (!Number.isFinite(div) || div <= 0) return null;
    return Number(raw) / div;
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve)=>setTimeout(resolve,ms));
}

async function fetchJson(url, timeoutMs = 8_000, retries = 2) {
  let lastError = null;

  for (let attempt=0; attempt<=retries; attempt+=1) {
    const controller = new AbortController();
    const timeout = setTimeout(()=>controller.abort(), timeoutMs);
    try {
      const r = await fetch(url, {
        signal: controller.signal,
        headers: { 'user-agent':'radar-cripto-carlos-dex/0.20' },
      });

      if (r.ok) return await r.json();

      const retryAfterHeader = Number(r.headers.get('retry-after'));
      const retryable = r.status === 429 || r.status >= 500;
      const retryAfterMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
        ? retryAfterHeader * 1000
        : Math.min(8_000, 1_000 * (2 ** attempt));
      lastError = new Error(`${new URL(url).hostname} HTTP ${r.status}`);

      if (!retryable || attempt >= retries) throw lastError;
      await sleep(retryAfterMs);
    } catch (error) {
      lastError = error;
      if (attempt >= retries || error?.name === 'AbortError') throw error;
      await sleep(Math.min(8_000,1_000*(2**attempt)));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error('fetch_failed');
}

function screeningStatus(token) {
  const candidates = [
    token?.screening?.status,
    token?.screening?.recommendation,
    token?.verification?.status,
    token?.verificationStatus,
    token?.security?.status,
    token?.securityStatus,
  ];
  const raw = candidates.find((x)=>typeof x === 'string');
  return raw ? raw.toLowerCase() : 'unknown';
}

function screeningAllowed(status) {
  return status !== 'denied';
}

async function refreshTokenMetadata() {
  if (Date.now() - state.tokensFetchedAt < TOKEN_CACHE_MS && state.tokenMetaByIdentity.size) return;
  const chainIds = [...new Set(DEX_ASSET_REGISTRY.map((asset)=>chainForAsset(asset)?.chainId).filter(Boolean))];
  const url = `${LIFI_BASE}/tokens?chains=${chainIds.join(',')}`;
  const next = new Map();

  try {
    const data = await fetchJson(url,10_000,2);
    const byChain = data?.tokens || {};

    for (const asset of DEX_ASSET_REGISTRY) {
      const chain = chainForAsset(asset);
      const tokens = byChain?.[String(chain.chainId)] || [];
      const exact = tokens.find((token)=>
        normalizeAddress(token?.address) === normalizeAddress(asset.address)
        && Number(token?.chainId) === chain.chainId
      );
      if (!exact) continue;
      next.set(exactIdentityKey(asset), {
        address: exact.address,
        symbol: exact.symbol,
        chainId: Number(exact.chainId),
        coinKey: exact.coinKey || null,
        screeningStatus: screeningStatus(exact),
        screeningSource: 'lifi',
      });
    }
  } catch (error) {
    for (const asset of DEX_ASSET_REGISTRY) {
      const chain = chainForAsset(asset);
      next.set(exactIdentityKey(asset), {
        address: asset.address,
        symbol: asset.symbol,
        chainId: chain.chainId,
        coinKey: asset.canonicalId,
        screeningStatus: 'unknown',
        screeningSource: `manual_registry_fallback:${error?.message || error}`,
      });
    }
  }

  state.tokenMetaByIdentity = next;
  state.tokensFetchedAt = Date.now();
}

async function refreshTools() {
  if (Date.now() - state.toolsFetchedAt < TOOL_CACHE_MS && state.toolKeys.length) return;

  try {
    const data = await fetchJson(`${LIFI_BASE}/tools`,10_000,2);
    const exchanges = Array.isArray(data?.exchanges) ? data.exchanges : [];
    state.toolKeys = exchanges
      .filter((tool)=>{
        const hay = `${tool?.key || ''} ${tool?.name || ''}`.toLowerCase();
        return CURATED_DEX_ID_ALIASES.some((alias)=>hay.includes(alias));
      })
      .map((tool)=>tool.key)
      .filter(Boolean);
  } catch {
    state.toolKeys = [...LIFI_TOOL_FALLBACK];
  }

  if (!state.toolKeys.length) state.toolKeys = [...LIFI_TOOL_FALLBACK];
  state.toolsFetchedAt = Date.now();
}

function poolIdentity(asset) {
  return exactIdentityKey(asset);
}

function liFiToolForDexId(dexId) {
  const id=String(dexId||'').toLowerCase();
  if (!id) return null;
  return state.toolKeys.find((tool)=>{
    const key=String(tool||'').toLowerCase();
    return key===id || key.includes(id) || id.includes(key);
  }) || null;
}

function poolMatchesAsset(pair, asset) {
  const chain = chainForAsset(asset);
  if (!chain) return false;
  if (!isCuratedDexId(pair?.dexId)) return false;

  // DEX Screener priceUsd refers to the base token. We therefore require the
  // exact registered token contract to be the base token, but we do NOT require
  // the pool quote token to be USDT. Executability is confirmed separately by
  // an exact same-chain USDT <-> token quote.
  const baseAddress = normalizeAddress(pair?.baseToken?.address);
  return baseAddress === normalizeAddress(asset.address);
}

async function refreshPools() {
  if (Date.now() - state.poolFetchedAt < POOL_CACHE_MS && state.poolsByIdentity.size) return;

  const next = new Map();
  const byChain = new Map();

  for (const asset of DEX_ASSET_REGISTRY) {
    const chain = chainForAsset(asset);
    if (!chain) continue;
    if (!byChain.has(asset.chain)) byChain.set(asset.chain,[]);
    byChain.get(asset.chain).push(asset);
  }

  for (const [chainKey,assets] of byChain.entries()) {
    const chain = chainForAsset(assets[0]);
    const tokenAddresses = assets.map((asset)=>asset.address).join(',');
    const url = `${DEXSCREENER_BASE}/tokens/v1/${chain.dexScreenerChain}/${tokenAddresses}`;
    const pairs = await fetchJson(url,10_000,3);
    const list = Array.isArray(pairs) ? pairs : [];

    for (const asset of assets) {
      const eligible = list
        .filter((pair)=>poolMatchesAsset(pair, asset))
        .filter((pair)=>(finitePositive(pair?.liquidity?.usd) || 0) >= MIN_POOL_LIQUIDITY_USD)
        .sort((a,b)=>(Number(b?.liquidity?.usd)||0)-(Number(a?.liquidity?.usd)||0));

      if (!eligible.length) continue;
      const confirmable = eligible.filter((pair)=>liFiToolForDexId(pair?.dexId));
      const pair = confirmable[0] || eligible[0];
      const lifiToolKey = liFiToolForDexId(pair?.dexId);
      next.set(poolIdentity(asset), {
        chain: chainKey,
        chainId: chain.chainId,
        cexSymbol: asset.cexSymbol,
        tokenAddress: asset.address,
        quoteAddress: chain.quoteAddress,
        dexId: pair.dexId,
        lifiToolKey,
        pairAddress: pair.pairAddress,
        priceUsd: finitePositive(pair.priceUsd),
        liquidityUsd: finitePositive(pair?.liquidity?.usd),
        volume24hUsd: finitePositive(pair?.volume?.h24),
        url: pair.url || null,
        fetchedAt: Date.now(),
      });
    }

    await sleep(300);
  }

  state.poolsByIdentity = next;
  state.poolFetchedAt = Date.now();
}

function bestCexSides(snapshot, symbol) {
  const sides = [];
  for (const [exchange, books] of Object.entries(snapshot?.books || {})) {
    const book = books?.[symbol];
    const bid = finitePositive(book?.bids?.[0]?.[0]);
    const bidQty = finitePositive(book?.bids?.[0]?.[1]);
    const ask = finitePositive(book?.asks?.[0]?.[0]);
    const askQty = finitePositive(book?.asks?.[0]?.[1]);
    if (!bid || !bidQty || !ask || !askQty) continue;
    sides.push({exchange,bid,bidQty,ask,askQty,book});
  }
  if (!sides.length) return null;
  const bestBuy = [...sides].sort((a,b)=>a.ask-b.ask)[0];
  const bestSell = [...sides].sort((a,b)=>b.bid-a.bid)[0];
  return {bestBuy,bestSell,sides};
}

function gasUsd(quote) {
  return (quote?.estimate?.gasCosts || [])
    .reduce((sum, item)=>sum + (Number(item?.amountUSD)||0), 0);
}

function feeUsd(quote) {
  return (quote?.estimate?.feeCosts || [])
    .reduce((sum, item)=>sum + (Number(item?.amountUSD)||0), 0);
}

function quoteIdentityMatches(quote, asset, direction) {
  const chain = chainForAsset(asset);
  const action = quote?.action;
  if (!action || Number(action.fromChainId)!==chain.chainId || Number(action.toChainId)!==chain.chainId) return false;
  const fromAddress = normalizeAddress(action?.fromToken?.address);
  const toAddress = normalizeAddress(action?.toToken?.address);
  if (direction === 'dex_to_cex') {
    return fromAddress === normalizeAddress(chain.quoteAddress)
      && toAddress === normalizeAddress(asset.address);
  }
  return fromAddress === normalizeAddress(asset.address)
    && toAddress === normalizeAddress(chain.quoteAddress);
}

function quoteToolCandidates(quote) {
  const out = [];
  const push = (value) => {
    if (typeof value === 'string' && value.trim()) out.push(value.trim());
  };

  push(quote?.tool);
  push(quote?.toolDetails?.key);
  push(quote?.toolDetails?.name);

  for (const step of quote?.includedSteps || []) {
    push(step?.tool);
    push(step?.toolDetails?.key);
    push(step?.toolDetails?.name);
  }

  return [...new Set(out)];
}

function curatedQuoteTool(quote) {
  const candidates = quoteToolCandidates(quote);
  return candidates.find((tool)=>isCuratedDexId(tool)) || null;
}

async function lifiQuote({asset, direction, amountUnits, allowedExchange}) {
  if (!allowedExchange) throw new Error('dex_not_supported_for_executable_quote');
  const chain = chainForAsset(asset);
  const fromToken = direction === 'dex_to_cex' ? chain.quoteAddress : asset.address;
  const toToken = direction === 'dex_to_cex' ? asset.address : chain.quoteAddress;
  const key = [chain.chainId,normalizeAddress(fromToken),normalizeAddress(toToken),String(amountUnits),allowedExchange].join(':');
  const cached = state.quoteCache.get(key);
  if (cached && Date.now()-cached.fetchedAt < QUOTE_CACHE_MS) return cached.quote;

  const params = new URLSearchParams({
    fromChain: String(chain.chainId),
    toChain: String(chain.chainId),
    fromToken,
    toToken,
    fromAddress: READ_ONLY_ADDRESS,
    toAddress: READ_ONLY_ADDRESS,
    fromAmount: String(amountUnits),
    slippage: String(LIFI_SLIPPAGE),
    order: 'RECOMMENDED',
    allowExchanges: allowedExchange,
    allowBridges: 'none',
  });

  const quote = await fetchJson(`${LIFI_BASE}/quote?${params.toString()}`, 7_000, 1);
  // LI.FI's allowExchanges parameter constrains the swap venue. We still verify
  // chain and exact token contracts separately via quoteIdentityMatches.
  quote.__curatedDexTool = allowedExchange;
  state.quoteCache.set(key,{quote,fetchedAt:Date.now()});
  return quote;
}

function preliminaryCandidates(snapshot, budgetUsdt) {
  const candidates = [];
  for (const asset of DEX_ASSET_REGISTRY) {
    const identity = poolIdentity(asset);
    const pool = state.poolsByIdentity.get(identity);
    const tokenMeta = state.tokenMetaByIdentity.get(identity);
    if (!pool?.priceUsd || !tokenMeta) continue;
    if (!screeningAllowed(tokenMeta.screeningStatus)) continue;

    const cex = bestCexSides(snapshot, asset.cexSymbol);
    if (!cex) continue;

    const dexMid = pool.priceUsd;
    const dexBuySpread = ((cex.bestSell.bid / dexMid) - 1) * 100;
    const dexSellSpread = ((dexMid / cex.bestBuy.ask) - 1) * 100;

    if (dexBuySpread >= MIN_PRELIMINARY_SPREAD_PCT) {
      candidates.push({asset,pool,tokenMeta,cex,direction:'dex_to_cex',preliminarySpreadPct:dexBuySpread,budgetUsdt});
    }
    if (dexSellSpread >= MIN_PRELIMINARY_SPREAD_PCT) {
      candidates.push({asset,pool,tokenMeta,cex,direction:'cex_to_dex',preliminarySpreadPct:dexSellSpread,budgetUsdt});
    }
  }

  return candidates
    .sort((a,b)=>b.preliminarySpreadPct-a.preliminarySpreadPct);
}

async function confirmCandidate(candidate, costs) {
  const {asset,pool,tokenMeta,cex,direction,budgetUsdt} = candidate;
  const chain = chainForAsset(asset);
  const reserveRate = (Number(costs?.reservePct)||0)/100;

  if (direction === 'dex_to_cex') {
    const budgetUnits = numberToUnits(budgetUsdt, chain.quoteDecimals);
    if (!budgetUnits) return null;
    const quote = await lifiQuote({asset,direction,amountUnits:budgetUnits,allowedExchange:pool.lifiToolKey});
    if (!quoteIdentityMatches(quote,asset,direction)) return null;

    const tokenOutMin = unitsToNumber(quote?.estimate?.toAmountMin, asset.decimals);
    if (!tokenOutMin) return null;
    const sold = consumeBase(cex.bestSell.book.bids, tokenOutMin);
    if (!sold?.filled) return null;

    const cexFee = sold.quoteReceived * (exchangeFeePct(cex.bestSell.exchange,costs)/100);
    const reserve = (budgetUsdt + sold.quoteReceived) * reserveRate;
    const gas = gasUsd(quote);
    const net = sold.quoteReceived - budgetUsdt - cexFee - reserve - gas;

    return {
      kind:'DEX_CEX',
      eligible:net>0,
      direction:'dex_to_cex',
      symbol:asset.cexSymbol,
      asset:asset.symbol,
      chain:chain.name,
      chainId:chain.chainId,
      contract:asset.address,
      identityKey:exactIdentityKey(asset),
      sameAssetVerified:true,
      identityMethod:'manual_cex_mapping+chainId+exact_contract+lifi_quote_echo',
      screeningStatus:tokenMeta.screeningStatus,
      dex:quote?.__curatedDexTool || quote?.toolDetails?.name || quote?.tool || pool.dexId,
      dexTool:quote?.__curatedDexTool || quote?.tool || null,
      cex:cex.bestSell.exchange,
      buyVenue:quote?.__curatedDexTool || quote?.toolDetails?.name || quote?.tool || pool.dexId,
      sellVenue:cex.bestSell.exchange,
      grossSpreadPct:((sold.quoteReceived/budgetUsdt)-1)*100,
      budgetUsdt,
      executableBudgetUsdt:budgetUsdt,
      dexTokenOutMin:tokenOutMin,
      cexSellVwap:sold.vwap,
      gasUsd:gas,
      lifiFeeUsd:feeUsd(quote),
      cexTradingFeeUsdt:cexFee,
      reserveUsdt:reserve,
      netPnlUsdt:net,
      netPct:(net/budgetUsdt)*100,
      poolLiquidityUsd:pool.liquidityUsd,
      poolVolume24hUsd:pool.volume24hUsd,
      pairUrl:pool.url,
      transferabilityVerified:false,
      routeType:'same_chain_inventory_prepositioned',
      quoteSlippage:LIFI_SLIPPAGE,
      quotedAt:Date.now(),
    };
  }

  const maxCexBudget = Math.min(budgetUsdt, cex.bestBuy.ask * cex.bestBuy.askQty);
  const bought = consumeQuote(cex.bestBuy.book.asks, maxCexBudget);
  if (!bought?.filled || !bought.baseQty) return null;
  const tokenUnits = numberToUnits(bought.baseQty, asset.decimals);
  if (!tokenUnits) return null;
  const quote = await lifiQuote({asset,direction,amountUnits:tokenUnits,allowedExchange:pool.lifiToolKey});
  if (!quoteIdentityMatches(quote,asset,direction)) return null;

  const stableOutMin = unitsToNumber(quote?.estimate?.toAmountMin, chain.quoteDecimals);
  if (!stableOutMin) return null;
  const cexFee = bought.quoteSpent * (exchangeFeePct(cex.bestBuy.exchange,costs)/100);
  const reserve = (bought.quoteSpent + stableOutMin) * reserveRate;
  const gas = gasUsd(quote);
  const net = stableOutMin - bought.quoteSpent - cexFee - reserve - gas;

  return {
    kind:'CEX_DEX',
    eligible:net>0,
    direction:'cex_to_dex',
    symbol:asset.cexSymbol,
    asset:asset.symbol,
    chain:chain.name,
    chainId:chain.chainId,
    contract:asset.address,
    identityKey:exactIdentityKey(asset),
    sameAssetVerified:true,
    identityMethod:'manual_cex_mapping+chainId+exact_contract+lifi_quote_echo',
    screeningStatus:tokenMeta.screeningStatus,
    dex:quote?.__curatedDexTool || quote?.toolDetails?.name || quote?.tool || pool.dexId,
    dexTool:quote?.__curatedDexTool || quote?.tool || null,
    cex:cex.bestBuy.exchange,
    buyVenue:cex.bestBuy.exchange,
    sellVenue:quote?.__curatedDexTool || quote?.toolDetails?.name || quote?.tool || pool.dexId,
    grossSpreadPct:((stableOutMin/bought.quoteSpent)-1)*100,
    budgetUsdt,
    executableBudgetUsdt:bought.quoteSpent,
    baseQty:bought.baseQty,
    cexBuyVwap:bought.vwap,
    dexStableOutMin:stableOutMin,
    gasUsd:gas,
    lifiFeeUsd:feeUsd(quote),
    cexTradingFeeUsdt:cexFee,
    reserveUsdt:reserve,
    netPnlUsdt:net,
    netPct:(net/bought.quoteSpent)*100,
    poolLiquidityUsd:pool.liquidityUsd,
    poolVolume24hUsd:pool.volume24hUsd,
    pairUrl:pool.url,
    transferabilityVerified:false,
    routeType:'same_chain_inventory_prepositioned',
    quoteSlippage:LIFI_SLIPPAGE,
    quotedAt:Date.now(),
  };
}

export async function buildDexRadar({snapshot,budgetUsdt,costsForSymbol}) {
  validateRegistry();
  await refreshTools().catch(()=>{});
  await Promise.all([refreshPools(),refreshTokenMetadata()]);
  const preliminary = preliminaryCandidates(snapshot,budgetUsdt);
  const toConfirm = preliminary
    .filter((candidate)=>candidate.preliminarySpreadPct>=MIN_CONFIRM_SPREAD_PCT)
    .filter((candidate)=>Boolean(candidate.pool?.lifiToolKey))
    .slice(0,MAX_CONFIRMED_CANDIDATES);
  const confirmed = [];

  for (const candidate of toConfirm) {
    try {
      const costs = costsForSymbol(candidate.asset.cexSymbol);
      const result = await confirmCandidate(candidate,costs);
      if (result) confirmed.push(result);
      await sleep(350);
    } catch (error) {
      confirmed.push({
        eligible:false,
        kind:'DEX_CEX_ERROR',
        symbol:candidate.asset.cexSymbol,
        chain:chainForAsset(candidate.asset)?.name,
        contract:candidate.asset.address,
        sameAssetVerified:true,
        error:error?.message || String(error),
        preliminarySpreadPct:candidate.preliminarySpreadPct,
      });
    }
  }

  const valid = confirmed.filter((x)=>Number.isFinite(x?.netPnlUsdt));
  const positives = valid
    .filter((x)=>x.eligible)
    .sort((a,b)=>b.netPnlUsdt-a.netPnlUsdt)
    .slice(0,5);
  const nearest = valid
    .filter((x)=>!x.eligible)
    .sort((a,b)=>b.netPnlUsdt-a.netPnlUsdt)
    .slice(0,5);

  const preliminaryTop5 = preliminary.slice(0,5).map((x)=>({
    kind:'DEX_CEX_PRELIMINARY',
    eligible:false,
    confirmedExecutable:false,
    symbol:x.asset.cexSymbol,
    asset:x.asset.symbol,
    chain:chainForAsset(x.asset)?.name,
    chainId:chainForAsset(x.asset)?.chainId,
    contract:x.asset.address,
    identityKey:exactIdentityKey(x.asset),
    sameAssetVerified:true,
    identityMethod:'manual_cex_mapping+chainId+exact_contract',
    dex:x.pool.dexId,
    poolLiquidityUsd:x.pool.liquidityUsd,
    poolVolume24hUsd:x.pool.volume24hUsd,
    pairUrl:x.pool.url,
    direction:x.direction,
    buyVenue:x.direction==='dex_to_cex' ? x.pool.dexId : x.cex.bestBuy.exchange,
    sellVenue:x.direction==='dex_to_cex' ? x.cex.bestSell.exchange : x.pool.dexId,
    preliminarySpreadPct:x.preliminarySpreadPct,
    status:'awaiting_executable_quote',
  }));

  return {
    generatedAt:Date.now(),
    mode:'same-chain-read-only',
    chains:[...new Set(DEX_ASSET_REGISTRY.map((x)=>chainForAsset(x)?.name).filter(Boolean))],
    curatedDexes:CURATED_DEX_NAMES,
    identityPolicy:'manual cex mapping + chainId + exact contract address; never ticker-only',
    transferabilityVerified:false,
    minPoolLiquidityUsd:MIN_POOL_LIQUIDITY_USD,
    registryAssets:DEX_ASSET_REGISTRY.length,
    poolsFound:state.poolsByIdentity.size,
    lifiDexTools:state.toolKeys.length ? state.toolKeys : LIFI_TOOL_FALLBACK,
    executableDexes:[...new Set([...state.poolsByIdentity.values()].map((pool)=>pool.lifiToolKey).filter(Boolean))],
    preliminaryCount:preliminary.length,
    preliminaryTop5,
    confirmedCount:valid.length,
    positiveCount:valid.filter((x)=>x.eligible).length,
    top5:positives,
    nearest5:nearest,
    errors:confirmed.filter((x)=>x.kind==='DEX_CEX_ERROR').slice(0,5),
  };
}

export function dexRegistrySnapshot() {
  return DEX_ASSET_REGISTRY.map((asset)=>{
    const chain=chainForAsset(asset);
    return {
      canonicalId:asset.canonicalId,
      cexSymbol:asset.cexSymbol,
      tokenSymbol:asset.symbol,
      chain:chain?.name,
      chainId:chain?.chainId,
      contract:asset.address,
      quoteSymbol:chain?.quoteSymbol,
      quoteContract:chain?.quoteAddress,
      identityKey:exactIdentityKey(asset),
      screeningStatus:state.tokenMetaByIdentity.get(exactIdentityKey(asset))?.screeningStatus || 'unknown',
      screeningSource:state.tokenMetaByIdentity.get(exactIdentityKey(asset))?.screeningSource || 'not_loaded',
      pool:state.poolsByIdentity.get(exactIdentityKey(asset)) || null,
    };
  });
}
