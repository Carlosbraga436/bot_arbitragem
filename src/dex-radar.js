import { consumeBase, consumeQuote, exchangeFeePct } from './core.js';
import {
  CURATED_DEX_NAMES,
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
const QUOTE_CACHE_MS = 20_000;
const MIN_POOL_LIQUIDITY_USD = 250_000;
const MIN_PRELIMINARY_SPREAD_PCT = 0.25;
const MAX_CONFIRMED_CANDIDATES = 6;
const LIFI_SLIPPAGE = 0.005;

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

async function fetchJson(url, timeoutMs = 8_000) {
  const controller = new AbortController();
  const timeout = setTimeout(()=>controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent':'radar-cripto-carlos-dex/0.1' },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timeout);
  }
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
  const data = await fetchJson(url);
  const byChain = data?.tokens || {};
  const next = new Map();

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
    });
  }

  state.tokenMetaByIdentity = next;
  state.tokensFetchedAt = Date.now();
}

async function refreshTools() {
  if (Date.now() - state.toolsFetchedAt < TOOL_CACHE_MS && state.toolKeys.length) return;
  const data = await fetchJson(`${LIFI_BASE}/tools`);
  const exchanges = Array.isArray(data?.exchanges) ? data.exchanges : [];
  const safeNames = CURATED_DEX_NAMES.map((x)=>x.toLowerCase());

  state.toolKeys = exchanges
    .filter((tool)=>{
      const hay = `${tool?.key || ''} ${tool?.name || ''}`.toLowerCase();
      return safeNames.some((name)=>hay.includes(name.toLowerCase().replace('swap','')) || hay.includes(name.toLowerCase()));
    })
    .map((tool)=>tool.key)
    .filter(Boolean);
  state.toolsFetchedAt = Date.now();
}

function poolIdentity(asset) {
  return exactIdentityKey(asset);
}

function poolMatchesAsset(pair, asset) {
  const chain = chainForAsset(asset);
  if (!chain) return false;
  if (!isCuratedDexId(pair?.dexId)) return false;
  const baseAddress = normalizeAddress(pair?.baseToken?.address);
  const quoteAddress = normalizeAddress(pair?.quoteToken?.address);
  return baseAddress === normalizeAddress(asset.address)
    && quoteAddress === normalizeAddress(chain.quoteAddress);
}

async function refreshPools() {
  if (Date.now() - state.poolFetchedAt < POOL_CACHE_MS && state.poolsByIdentity.size) return;

  const next = new Map();
  const byChain = new Map();
  for (const asset of DEX_ASSET_REGISTRY) {
    const chain = chainForAsset(asset);
    if (!chain) continue;
    if (!byChain.has(asset.chain)) byChain.set(asset.chain, []);
    byChain.get(asset.chain).push(asset);
  }

  for (const [chainKey, assets] of byChain.entries()) {
    const chain = chainForAsset(assets[0]);
    for (let i=0; i<assets.length; i+=30) {
      const batch = assets.slice(i, i+30);
      const addresses = batch.map((asset)=>asset.address).join(',');
      const url = `${DEXSCREENER_BASE}/tokens/v1/${chain.dexScreenerChain}/${addresses}`;
      const pairs = await fetchJson(url);
      const list = Array.isArray(pairs) ? pairs : [];

      for (const asset of batch) {
        const eligible = list
          .filter((pair)=>poolMatchesAsset(pair, asset))
          .filter((pair)=>(finitePositive(pair?.liquidity?.usd) || 0) >= MIN_POOL_LIQUIDITY_USD)
          .sort((a,b)=>(Number(b?.liquidity?.usd)||0)-(Number(a?.liquidity?.usd)||0));
        if (!eligible.length) continue;
        const pair = eligible[0];
        next.set(poolIdentity(asset), {
          chain: chainKey,
          chainId: chain.chainId,
          cexSymbol: asset.cexSymbol,
          tokenAddress: asset.address,
          quoteAddress: chain.quoteAddress,
          dexId: pair.dexId,
          pairAddress: pair.pairAddress,
          priceUsd: finitePositive(pair.priceUsd),
          liquidityUsd: finitePositive(pair?.liquidity?.usd),
          volume24hUsd: finitePositive(pair?.volume?.h24),
          url: pair.url || null,
          fetchedAt: Date.now(),
        });
      }
    }
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

async function lifiQuote({asset, direction, amountUnits}) {
  await refreshTools();
  if (!state.toolKeys.length) throw new Error('no_curated_lifi_dex_tools');

  const chain = chainForAsset(asset);
  const fromToken = direction === 'dex_to_cex' ? chain.quoteAddress : asset.address;
  const toToken = direction === 'dex_to_cex' ? asset.address : chain.quoteAddress;
  const key = [chain.chainId,normalizeAddress(fromToken),normalizeAddress(toToken),String(amountUnits),state.toolKeys.join(',')].join(':');
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
    allowExchanges: state.toolKeys.join(','),
  });
  const quote = await fetchJson(`${LIFI_BASE}/quote?${params.toString()}`, 12_000);
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
    .sort((a,b)=>b.preliminarySpreadPct-a.preliminarySpreadPct)
    .slice(0,MAX_CONFIRMED_CANDIDATES);
}

async function confirmCandidate(candidate, costs) {
  const {asset,pool,tokenMeta,cex,direction,budgetUsdt} = candidate;
  const chain = chainForAsset(asset);
  const reserveRate = (Number(costs?.reservePct)||0)/100;

  if (direction === 'dex_to_cex') {
    const budgetUnits = numberToUnits(budgetUsdt, chain.quoteDecimals);
    if (!budgetUnits) return null;
    const quote = await lifiQuote({asset,direction,amountUnits:budgetUnits});
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
      dex:quote?.toolDetails?.name || quote?.tool || pool.dexId,
      dexTool:quote?.tool || null,
      cex:cex.bestSell.exchange,
      buyVenue:quote?.toolDetails?.name || quote?.tool || pool.dexId,
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
  const quote = await lifiQuote({asset,direction,amountUnits:tokenUnits});
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
    dex:quote?.toolDetails?.name || quote?.tool || pool.dexId,
    dexTool:quote?.tool || null,
    cex:cex.bestBuy.exchange,
    buyVenue:cex.bestBuy.exchange,
    sellVenue:quote?.toolDetails?.name || quote?.tool || pool.dexId,
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
  await Promise.all([refreshPools(),refreshTokenMetadata(),refreshTools()]);
  const preliminary = preliminaryCandidates(snapshot,budgetUsdt);
  const confirmed = [];

  for (const candidate of preliminary) {
    try {
      const costs = costsForSymbol(candidate.asset.cexSymbol);
      const result = await confirmCandidate(candidate,costs);
      if (result) confirmed.push(result);
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
    lifiDexTools:state.toolKeys,
    preliminaryCount:preliminary.length,
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
      pool:state.poolsByIdentity.get(exactIdentityKey(asset)) || null,
    };
  });
}
