import { consumeBase, consumeQuote, exchangeFeePct } from './core.js';
import { depthCapacity, fetchCexDepth } from './cex-depth.js';
import { validateCexRebalance } from './cex-network.js';
import {
  applyDirectSlippage,
  directDexAdapterFor,
  directDexQuote,
  directDexSnapshot,
} from './dex-direct-quote.js';
import {
  AUTO_ASSET_ALLOWLIST,
  CURATED_DEX_NAMES,
  CURATED_DEX_ID_ALIASES,
  DEX_ASSET_REGISTRY,
  DEX_CHAINS,
  buildAutoAssetRegistry,
  chainForAsset,
  exactIdentityKey,
  isCuratedDexId,
  mergeAssetRegistries,
  normalizeAddress,
  validateRegistry,
} from './dex-registry.js';

const DEXSCREENER_BASE = 'https://api.dexscreener.com';
const LIFI_BASE = 'https://li.quest/v1';
const UNISWAP_TOKEN_LIST = 'https://tokens.uniswap.org';
const READ_ONLY_ADDRESS = '0x0000000000000000000000000000000000000001';

const POOL_CACHE_MS = 30_000;
const TOOL_CACHE_MS = 10 * 60_000;
const TOKEN_CACHE_MS = 10 * 60_000;
const AUTO_REGISTRY_CACHE_MS = 30 * 60_000;
const QUOTE_CACHE_MS = 120_000;
const MIN_POOL_LIQUIDITY_USD = 250_000;
const MIN_POOL_VOLUME_24H_USD = 10_000;
const TRUSTED_POOL_QUOTES = Object.freeze({
  ethereum: new Set([
    '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH
    '0x6b175474e89094c44da98b954eedeac495271d0f', // DAI
  ]),
  arbitrum: new Set([
    '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
    '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8',
    '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1',
  ]),
  base: new Set([
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
    '0x4200000000000000000000000000000000000006', // WETH
  ]),
  polygon: new Set([
    '0xc2132d05d31c914a87c6611c10748aacbb58e8f', // USDT
    '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', // native USDC
    '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', // USDC.e
    '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619', // WETH
    '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063', // DAI
  ]),
  bsc: new Set([
    '0x55d398326f99059ff775485246999027b3197955', // USDT
    '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', // USDC
    '0x2170ed0880ac9a755fd29b2688956bd959f933f8', // ETH
  ]),
});
const MIN_PRELIMINARY_SPREAD_PCT = 0.25;
const MIN_CONFIRM_SPREAD_PCT = 0.50;
const MAX_DIRECT_CONFIRMATIONS = 4;
const MAX_FALLBACK_CONFIRMATIONS = 3;
const DEXSCREENER_BATCH_SIZE = 25;
const LIFI_SLIPPAGE = 0.005;
const DIRECT_SLIPPAGE_BPS = 50;
const MIN_EXECUTION_USDT = 10;
const CAPACITY_SEARCH_STEPS = Object.freeze([1,0.50,0.25,0.10]);
const CAPACITY_BINARY_STEPS = 2;
const LIFI_QUOTE_DELAY_MS = 1_100;
const DIRECT_QUOTE_DELAY_MS = 120;
const LIFI_TOOL_FALLBACK = Object.freeze([
  'uniswap',
  'sushiswap',
  'curve',
  'balancer',
  'pancakeswap',
  'camelot',
  'aerodrome',
  'quickswap',
]);

const state = {
  poolsByIdentity: new Map(),
  poolFetchedAt: 0,
  toolKeys: [],
  toolsFetchedAt: 0,
  tokenMetaByIdentity: new Map(),
  tokensFetchedAt: 0,
  quoteCache: new Map(),
  autoAssets: [],
  autoRegistryFetchedAt: 0,
  lifiTokenPayload: null,
  lifiTokenFetchedAt: 0,
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
        headers: { 'user-agent':'radar-cripto-carlos-dex/0.23.0' },
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

function effectiveAssets() {
  return mergeAssetRegistries(DEX_ASSET_REGISTRY,state.autoAssets);
}

function flattenLifiTokens(payload) {
  const byChain=payload?.tokens || {};
  return Object.values(byChain).flatMap((tokens)=>Array.isArray(tokens)?tokens:[]);
}

async function getLifiTokenPayload() {
  if (state.lifiTokenPayload && Date.now()-state.lifiTokenFetchedAt<TOKEN_CACHE_MS) return state.lifiTokenPayload;
  const chainIds=[...new Set(Object.values(DEX_CHAINS).map((chain)=>chain?.chainId).filter(Boolean))];
  const url=`${LIFI_BASE}/tokens?chains=${chainIds.join(',')}`;
  const payload=await fetchJson(url,10_000,2);
  state.lifiTokenPayload=payload;
  state.lifiTokenFetchedAt=Date.now();
  return payload;
}

async function refreshAutoRegistry() {
  if (Date.now()-state.autoRegistryFetchedAt<AUTO_REGISTRY_CACHE_MS && state.autoAssets.length) return;
  try {
    const [uniswapList,lifiPayload]=await Promise.all([
      fetchJson(UNISWAP_TOKEN_LIST,10_000,2),
      getLifiTokenPayload(),
    ]);
    state.autoAssets=buildAutoAssetRegistry({
      uniswapTokens:Array.isArray(uniswapList?.tokens)?uniswapList.tokens:[],
      lifiTokens:flattenLifiTokens(lifiPayload),
      allowlist:AUTO_ASSET_ALLOWLIST,
    });
  } catch {
    state.autoAssets=[];
  }
  state.autoRegistryFetchedAt=Date.now();
}

async function refreshTokenMetadata() {
  if (Date.now() - state.tokensFetchedAt < TOKEN_CACHE_MS && state.tokenMetaByIdentity.size) return;
  const assets=effectiveAssets();
  const next = new Map();

  try {
    const data = await getLifiTokenPayload();
    const byChain = data?.tokens || {};

    for (const asset of assets) {
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
        screeningSource: 'lifi_exact_contract',
      });
    }
  } catch (error) {
    for (const asset of assets) {
      const chain = chainForAsset(asset);
      next.set(exactIdentityKey(asset), {
        address: asset.address,
        symbol: asset.symbol,
        chainId: chain.chainId,
        coinKey: asset.canonicalId,
        screeningStatus: 'unknown',
        screeningSource: `${asset.identitySource||'exact_registry'}_fallback:${error?.message || error}`,
      });
    }
  }

  for (const asset of assets) {
    const key=exactIdentityKey(asset);
    if (next.has(key)) continue;
    const chain=chainForAsset(asset);
    next.set(key,{
      address:asset.address,
      symbol:asset.symbol,
      chainId:chain.chainId,
      coinKey:asset.canonicalId,
      screeningStatus:'unknown',
      screeningSource:asset.identitySource||'exact_registry',
    });
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

  const announced=state.toolKeys.find((tool)=>{
    const key=String(tool||'').toLowerCase();
    return key===id || key.includes(id) || id.includes(key);
  });
  if (announced) return announced;

  // /tools can be incomplete under the public unauthenticated quota.
  // Curated fallback is safe because /quote is still constrained by allowExchanges
  // and failures stay non-executable.
  return LIFI_TOOL_FALLBACK.find((tool)=>{
    const key=String(tool||'').toLowerCase();
    return key===id || key.includes(id) || id.includes(key);
  }) || null;
}

export function poolReferenceIsTrusted(pair, asset) {
  const chainKey=asset?.chain;
  const trusted=TRUSTED_POOL_QUOTES[chainKey];
  if (!trusted) return false;
  const quoteAddress=normalizeAddress(pair?.quoteToken?.address);
  return Boolean(quoteAddress && trusted.has(quoteAddress));
}

function poolMatchesAsset(pair, asset) {
  const chain = chainForAsset(asset);
  if (!chain) return false;
  if (!isCuratedDexId(pair?.dexId)) return false;

  // DEX Screener priceUsd is only a discovery/reference price. Requiring the
  // exact registered base token is not enough: a junk or stale quote token can
  // manufacture absurd USD prices even when the base contract is genuine.
  // Only trusted stable/WETH quote contracts may feed preliminary spreads.
  const baseAddress = normalizeAddress(pair?.baseToken?.address);
  return baseAddress === normalizeAddress(asset.address)
    && poolReferenceIsTrusted(pair,asset);
}

function chunks(values,size) {
  const out=[];
  for (let i=0;i<values.length;i+=size) out.push(values.slice(i,i+size));
  return out;
}

async function refreshPools() {
  if (Date.now() - state.poolFetchedAt < POOL_CACHE_MS && state.poolsByIdentity.size) return;

  const next = new Map();
  const byChain = new Map();

  for (const asset of effectiveAssets()) {
    const chain = chainForAsset(asset);
    if (!chain) continue;
    if (!byChain.has(asset.chain)) byChain.set(asset.chain,[]);
    byChain.get(asset.chain).push(asset);
  }

  for (const [chainKey,assets] of byChain.entries()) {
    const chain = chainForAsset(assets[0]);
    const lists=[];
    for (const batch of chunks(assets,DEXSCREENER_BATCH_SIZE)) {
      const tokenAddresses=[...new Set(batch.map((asset)=>asset.address))].join(',');
      const url=`${DEXSCREENER_BASE}/tokens/v1/${chain.dexScreenerChain}/${tokenAddresses}`;
      const pairs=await fetchJson(url,10_000,3);
      if (Array.isArray(pairs)) lists.push(...pairs);
      await sleep(180);
    }

    for (const asset of assets) {
      const eligible = lists
        .filter((pair)=>poolMatchesAsset(pair, asset))
        .filter((pair)=>(finitePositive(pair?.liquidity?.usd) || 0) >= MIN_POOL_LIQUIDITY_USD)
        .filter((pair)=>(finitePositive(pair?.volume?.h24) || 0) >= MIN_POOL_VOLUME_24H_USD)
        .sort((a,b)=>(Number(b?.liquidity?.usd)||0)-(Number(a?.liquidity?.usd)||0));

      if (!eligible.length) continue;
      const confirmable = eligible.filter((pair)=>
        Boolean(directDexAdapterFor(pair?.dexId,chainKey) || liFiToolForDexId(pair?.dexId))
      );
      const pair = confirmable[0] || eligible[0];
      const lifiToolKey = liFiToolForDexId(pair?.dexId);
      const directAdapter = directDexAdapterFor(pair?.dexId,chainKey);
      next.set(poolIdentity(asset), {
        chain: chainKey,
        chainId: chain.chainId,
        cexSymbol: asset.cexSymbol,
        tokenAddress: asset.address,
        quoteAddress: chain.quoteAddress,
        dexId: pair.dexId,
        lifiToolKey,
        directAdapter,
        pairAddress: pair.pairAddress,
        priceUsd: finitePositive(pair.priceUsd),
        liquidityUsd: finitePositive(pair?.liquidity?.usd),
        volume24hUsd: finitePositive(pair?.volume?.h24),
        url: pair.url || null,
        fetchedAt: Date.now(),
      });
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

function directGasUsd(direct,nativeGasTokenUsd,chainKey) {
  const nativeUsd=finitePositive(nativeGasTokenUsd);
  if (!nativeUsd) return chainKey==='ethereum'?5:0.25;
  try {
    const gasWei=BigInt(direct?.gasEstimate||240_000n)*BigInt(direct?.gasPriceWei||0n);
    const native=Number(gasWei)/1e18;
    if (!Number.isFinite(native) || native<0) return chainKey==='ethereum'?5:0.25;
    return native*nativeUsd*1.25;
  } catch {
    return chainKey==='ethereum'?5:0.25;
  }
}

async function executableDexQuote({candidate,amountUnits}) {
  const {asset,pool,direction,nativeGasTokenUsd}=candidate;
  const chain=chainForAsset(asset);
  const fromToken=direction==='dex_to_cex'?chain.quoteAddress:asset.address;
  const toToken=direction==='dex_to_cex'?asset.address:chain.quoteAddress;
  let directError=null;

  if (pool?.directAdapter) {
    try {
      const direct=await directDexQuote({
        dexId:pool.dexId,
        chainKey:asset.chain,
        tokenIn:fromToken,
        tokenOut:toToken,
        amountIn:amountUnits,
      });
      const amountOutMin=applyDirectSlippage(direct.amountOut,DIRECT_SLIPPAGE_BPS);
      return {
        amountOutMin,
        gasUsd:directGasUsd(direct,nativeGasTokenUsd,asset.chain),
        explicitFeeUsd:0,
        quoteSource:'direct_onchain',
        quoteSourceLabel:`${direct.protocol} direto on-chain`,
        dexTool:direct.protocol,
        dexLabel:pool.dexId,
        directAdapter:direct.adapter,
        directContract:direct.contract,
        feeTier:direct.feeTier||null,
        identityMethod:'explicit_cex_mapping+chainId+exact_contract+direct_dex_eth_call',
      };
    } catch (error) {
      directError=error?.message||String(error);
    }
  }

  if (pool?.lifiToolKey) {
    const quote=await lifiQuote({
      asset,
      direction,
      amountUnits,
      allowedExchange:pool.lifiToolKey,
    });
    if (!quoteIdentityMatches(quote,asset,direction)) throw new Error('identity_quote_mismatch');
    const amountOutMinRaw=quote?.estimate?.toAmountMin;
    if (amountOutMinRaw==null) throw new Error('invalid_lifi_amount');
    return {
      amountOutMin:BigInt(String(amountOutMinRaw)),
      gasUsd:gasUsd(quote),
      explicitFeeUsd:feeUsd(quote),
      quoteSource:'lifi_fallback',
      quoteSourceLabel:'LI.FI fallback',
      dexTool:quote?.__curatedDexTool||quote?.tool||pool.lifiToolKey,
      dexLabel:quote?.__curatedDexTool||quote?.toolDetails?.name||quote?.tool||pool.dexId,
      directAdapter:pool?.directAdapter||null,
      directFallbackError:directError,
      identityMethod:'explicit_cex_mapping+chainId+exact_contract+lifi_quote_echo',
    };
  }

  throw new Error(`no_executable_quote_adapter:${directError||pool?.dexId||'unknown'}`);
}

function nativeEthUsd(snapshot) {
  const values=[];
  for (const books of Object.values(snapshot?.books||{})) {
    const book=books?.ETHUSDT;
    const bid=finitePositive(book?.bids?.[0]?.[0]);
    const ask=finitePositive(book?.asks?.[0]?.[0]);
    if (bid&&ask) values.push((bid+ask)/2);
  }
  if (!values.length) return null;
  values.sort((a,b)=>a-b);
  return values[Math.floor(values.length/2)];
}

function preliminaryCandidates(snapshot, budgetUsdt) {
  const candidates = [];
  const nativeGasTokenUsd=nativeEthUsd(snapshot);
  for (const asset of effectiveAssets()) {
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
      candidates.push({asset,pool,tokenMeta,cex,direction:'dex_to_cex',preliminarySpreadPct:dexBuySpread,budgetUsdt,nativeGasTokenUsd});
    }
    if (dexSellSpread >= MIN_PRELIMINARY_SPREAD_PCT) {
      candidates.push({asset,pool,tokenMeta,cex,direction:'cex_to_dex',preliminarySpreadPct:dexSellSpread,budgetUsdt,nativeGasTokenUsd});
    }
  }

  return candidates
    .sort((a,b)=>b.preliminarySpreadPct-a.preliminarySpreadPct);
}

function roundedBudget(value) {
  const n=finitePositive(value);
  return n ? Math.max(MIN_EXECUTION_USDT,Math.floor(n*100)/100) : null;
}

function uniqueDescending(values) {
  return [...new Set(values.filter((x)=>finitePositive(x)).map((x)=>roundedBudget(x)))]
    .filter((x)=>finitePositive(x))
    .sort((a,b)=>b-a);
}

export function capacitySearchBudgets(maximumBudgetUsdt) {
  const maximum=finitePositive(maximumBudgetUsdt);
  if (!maximum || maximum<MIN_EXECUTION_USDT) return [];
  return uniqueDescending([
    ...CAPACITY_SEARCH_STEPS.map((ratio)=>maximum*ratio),
    MIN_EXECUTION_USDT,
  ]).filter((budget)=>budget<=maximum+1e-9);
}

function cexCapacityBudget(direction, depth, poolPriceUsd, requestedBudgetUsdt) {
  const capacity=depthCapacity(depth);
  const requested=finitePositive(requestedBudgetUsdt);
  if (!requested) return null;

  if (direction==='cex_to_dex') {
    return Math.min(requested,capacity.askQuote);
  }

  const approximateQuoteCapacity=capacity.bidBase * (finitePositive(poolPriceUsd)||0);
  return Math.min(requested,approximateQuoteCapacity);
}

async function evaluateCandidateAtBudget({candidate,costs,depth,budgetUsdt}) {
  const {asset,pool,tokenMeta,cex,direction} = candidate;
  const chain=chainForAsset(asset);
  const reserveRate=(Number(costs?.reservePct)||0)/100;
  const budget=roundedBudget(budgetUsdt);
  if (!budget) return null;

  if (direction==='dex_to_cex') {
    const budgetUnits=numberToUnits(budget,chain.quoteDecimals);
    if (!budgetUnits) return null;
    const quote=await executableDexQuote({candidate,amountUnits:budgetUnits});
    const tokenOutMin=unitsToNumber(quote.amountOutMin,asset.decimals);
    if (!tokenOutMin) return {eligible:false,reason:'invalid_dex_amount',budgetUsdt:budget,netPnlUsdt:-Infinity};
    const sold=consumeBase(depth.bids,tokenOutMin);
    if (!sold?.filled) {
      return {
        eligible:false,
        reason:'cex_depth_insufficient',
        budgetUsdt:budget,
        executableBudgetUsdt:null,
        baseNeeded:tokenOutMin,
        baseVisible:sold?.baseSold||0,
        netPnlUsdt:-Infinity,
      };
    }

    const cexFee=sold.quoteReceived*(exchangeFeePct(cex.bestSell.exchange,costs)/100);
    const reserve=(budget+sold.quoteReceived)*reserveRate;
    const gas=Number(quote.gasUsd)||0;
    const dexFee=Number(quote.explicitFeeUsd)||0;
    const net=sold.quoteReceived-budget-cexFee-reserve-gas-dexFee;

    return {
      eligible:net>0,
      reason:net>0?'positive_net':'non_positive_net',
      direction,
      symbol:asset.cexSymbol,
      asset:asset.symbol,
      chain:chain.name,
      chainId:chain.chainId,
      contract:asset.address,
      identityKey:exactIdentityKey(asset),
      sameAssetVerified:true,
      identityMethod:quote.identityMethod,
      identitySource:asset.identitySource||'manual_exact_contract',
      screeningStatus:tokenMeta.screeningStatus,
      dex:quote.dexLabel||pool.dexId,
      dexTool:quote.dexTool||null,
      quoteSource:quote.quoteSource,
      quoteSourceLabel:quote.quoteSourceLabel,
      directAdapter:quote.directAdapter||null,
      directFallbackError:quote.directFallbackError||null,
      cex:cex.bestSell.exchange,
      buyVenue:quote.dexLabel||pool.dexId,
      sellVenue:cex.bestSell.exchange,
      grossSpreadPct:((sold.quoteReceived/budget)-1)*100,
      budgetUsdt:budget,
      executableBudgetUsdt:budget,
      dexTokenOutMin:tokenOutMin,
      cexSellVwap:sold.vwap,
      gasUsd:gas,
      lifiFeeUsd:quote.quoteSource==='lifi_fallback'?Number(quote.explicitFeeUsd||0):0,
      dexRoutingFeeUsd:dexFee,
      cexTradingFeeUsdt:cexFee,
      reserveUsdt:reserve,
      netPnlUsdt:net,
      netPct:(net/budget)*100,
      poolLiquidityUsd:pool.liquidityUsd,
      poolVolume24hUsd:pool.volume24hUsd,
      pairUrl:pool.url,
      routeType:'same_chain_inventory_prepositioned',
      quoteSlippage:LIFI_SLIPPAGE,
      quotedAt:Date.now(),
    };
  }

  const bought=consumeQuote(depth.asks,budget);
  if (!bought?.filled || !bought.baseQty) {
    return {
      eligible:false,
      reason:'cex_depth_insufficient',
      budgetUsdt:budget,
      executableBudgetUsdt:null,
      netPnlUsdt:-Infinity,
    };
  }

  const tokenUnits=numberToUnits(bought.baseQty,asset.decimals);
  if (!tokenUnits) return null;
  const quote=await executableDexQuote({candidate,amountUnits:tokenUnits});
  const stableOutMin=unitsToNumber(quote.amountOutMin,chain.quoteDecimals);
  if (!stableOutMin) return {eligible:false,reason:'invalid_dex_amount',budgetUsdt:budget,netPnlUsdt:-Infinity};

  const cexFee=bought.quoteSpent*(exchangeFeePct(cex.bestBuy.exchange,costs)/100);
  const reserve=(bought.quoteSpent+stableOutMin)*reserveRate;
  const gas=Number(quote.gasUsd)||0;
  const dexFee=Number(quote.explicitFeeUsd)||0;
  const net=stableOutMin-bought.quoteSpent-cexFee-reserve-gas-dexFee;

  return {
    eligible:net>0,
    reason:net>0?'positive_net':'non_positive_net',
    direction,
    symbol:asset.cexSymbol,
    asset:asset.symbol,
    chain:chain.name,
    chainId:chain.chainId,
    contract:asset.address,
    identityKey:exactIdentityKey(asset),
    sameAssetVerified:true,
    identityMethod:quote.identityMethod,
    identitySource:asset.identitySource||'manual_exact_contract',
    screeningStatus:tokenMeta.screeningStatus,
    dex:quote.dexLabel||pool.dexId,
    dexTool:quote.dexTool||null,
    quoteSource:quote.quoteSource,
    quoteSourceLabel:quote.quoteSourceLabel,
    directAdapter:quote.directAdapter||null,
    directFallbackError:quote.directFallbackError||null,
    cex:cex.bestBuy.exchange,
    buyVenue:cex.bestBuy.exchange,
    sellVenue:quote.dexLabel||pool.dexId,
    grossSpreadPct:((stableOutMin/bought.quoteSpent)-1)*100,
    budgetUsdt:bought.quoteSpent,
    executableBudgetUsdt:bought.quoteSpent,
    baseQty:bought.baseQty,
    cexBuyVwap:bought.vwap,
    dexStableOutMin:stableOutMin,
    gasUsd:gas,
    lifiFeeUsd:quote.quoteSource==='lifi_fallback'?Number(quote.explicitFeeUsd||0):0,
    dexRoutingFeeUsd:dexFee,
    cexTradingFeeUsdt:cexFee,
    reserveUsdt:reserve,
    netPnlUsdt:net,
    netPct:(net/bought.quoteSpent)*100,
    poolLiquidityUsd:pool.liquidityUsd,
    poolVolume24hUsd:pool.volume24hUsd,
    pairUrl:pool.url,
    routeType:'same_chain_inventory_prepositioned',
    quoteSlippage:LIFI_SLIPPAGE,
    quotedAt:Date.now(),
  };
}

async function findMaximumProfitable({candidate,costs,depth}) {
  const requested=finitePositive(candidate?.budgetUsdt);
  const cap=cexCapacityBudget(candidate.direction,depth,candidate.pool?.priceUsd,requested);
  if (!requested || !finitePositive(cap) || cap<MIN_EXECUTION_USDT) {
    return {
      best:null,
      attempts:[],
      requestedBudgetUsdt:requested,
      visibleCexCapacityUsdt:cap||0,
      liquidityLimited:true,
    };
  }

  const maximum=Math.min(requested,cap);
  const budgets=capacitySearchBudgets(maximum);
  const attempts=[];
  let positive=null;
  let previousHigher=null;

  for (const budget of budgets) {
    const result=await evaluateCandidateAtBudget({candidate,costs,depth,budgetUsdt:budget});
    if (result) attempts.push(result);
    if (result?.eligible) {
      positive=result;
      break;
    }
    previousHigher=budget;
    await sleep(candidate.pool?.directAdapter?DIRECT_QUOTE_DELAY_MS:LIFI_QUOTE_DELAY_MS);
  }

  if (positive && previousHigher && previousHigher>positive.budgetUsdt) {
    let low=positive.budgetUsdt;
    let high=previousHigher;
    for (let i=0;i<CAPACITY_BINARY_STEPS;i+=1) {
      const mid=roundedBudget((low+high)/2);
      if (!mid || mid<=low || mid>=high) break;
      const result=await evaluateCandidateAtBudget({candidate,costs,depth,budgetUsdt:mid});
      if (result) attempts.push(result);
      if (result?.eligible) {
        positive=result;
        low=mid;
      } else {
        high=mid;
      }
      await sleep(candidate.pool?.directAdapter?DIRECT_QUOTE_DELAY_MS:LIFI_QUOTE_DELAY_MS);
    }
  }

  const finiteAttempts=attempts.filter((x)=>Number.isFinite(x?.netPnlUsdt));
  const best=positive || finiteAttempts.sort((a,b)=>b.netPnlUsdt-a.netPnlUsdt)[0] || null;

  return {
    best,
    attempts,
    requestedBudgetUsdt:requested,
    visibleCexCapacityUsdt:cap,
    liquidityLimited:maximum+1e-9<requested || Boolean(best && best.budgetUsdt+1e-9<requested),
  };
}

async function confirmCandidate(candidate, costs) {
  const {asset,cex,direction,budgetUsdt}=candidate;
  const cexExchange=direction==='dex_to_cex'
    ? cex.bestSell.exchange
    : cex.bestBuy.exchange;

  const depth=await fetchCexDepth(cexExchange,asset.cexSymbol,100);
  const depthAgeMs=Math.max(0,Date.now()-Number(depth?.ts||Date.now()));
  if (depthAgeMs>8_000) {
    throw new Error(`stale_cex_depth:${depthAgeMs}`);
  }

  const search=await findMaximumProfitable({candidate,costs,depth});
  if (!search.best) {
    return {
      eligible:false,
      kind:'DEX_CEX_DEPTH',
      symbol:asset.cexSymbol,
      asset:asset.symbol,
      chain:chainForAsset(asset)?.name,
      chainId:chainForAsset(asset)?.chainId,
      contract:asset.address,
      sameAssetVerified:true,
      reason:'no_executable_budget_after_depth_confirmation',
      requestedBudgetUsdt:budgetUsdt,
      visibleCexCapacityUsdt:search.visibleCexCapacityUsdt,
      depthConfirmed:true,
      cexDepthExchange:cexExchange,
      cexDepthLevels:Number(depth?.levels)||0,
      cexDepthSource:depth?.source||null,
      netPnlUsdt:-Infinity,
    };
  }

  const rebalance=await validateCexRebalance(cexExchange,asset,direction);
  const rebalanceStatus=rebalance.status;
  const knownRestricted=rebalanceStatus==='restricted';
  const tokenNetwork=rebalance.tokenNetwork;
  const quoteNetwork=rebalance.quoteNetwork;

  return {
    ...search.best,
    kind:search.best.direction==='dex_to_cex'?'DEX_CEX':'CEX_DEX',
    eligible:Boolean(search.best.eligible) && !knownRestricted,
    economicsEligible:Boolean(search.best.eligible),
    operationalReady:knownRestricted?false:(rebalanceStatus==='verified_open'?true:null),
    requestedBudgetUsdt:budgetUsdt,
    maxProfitableBudgetUsdt:search.best.eligible?search.best.budgetUsdt:null,
    visibleCexCapacityUsdt:search.visibleCexCapacityUsdt,
    liquidityLimited:search.liquidityLimited,
    capacitySearchAttempts:search.attempts.length,
    depthConfirmed:true,
    cexDepthExchange:cexExchange,
    cexDepthLevels:Number(depth?.levels)||0,
    cexDepthAgeMs:depthAgeMs,
    cexDepthSource:depth?.source||null,
    rebalanceStatus,
    transferabilityVerified:rebalanceStatus==='verified_open',
    rebalanceRequirements:rebalance.requirements,
    rebalanceVerifiedRequirements:rebalance.verifiedRequirements,
    rebalanceRequirementCount:rebalance.totalRequirements,
    cexContractVerified:typeof tokenNetwork?.contractVerified==='boolean'
      ? tokenNetwork.contractVerified
      : null,
    cexContractStatus:tokenNetwork?.contractStatus||'not_publicly_verifiable',
    cexIdentityConfidence:tokenNetwork?.contractVerified===true
      ? 'exact_public_contract_match'
      : (tokenNetwork?.contractVerified===false?'contract_mismatch':'manual_mapping_contract_unverified'),
    quoteContractVerified:typeof quoteNetwork?.contractVerified==='boolean'
      ? quoteNetwork.contractVerified
      : null,
    quoteContractStatus:quoteNetwork?.contractStatus||'not_publicly_verifiable',
    cexNetwork:tokenNetwork,
    quoteNetwork,
    knownNetworkRestriction:knownRestricted,
    confirmationModel:`${search.best.quoteSource||'dex_quote'}+100_level_cex_depth+explicit_cex_mapping+directional_token_usdt_rebalance_validation_when_public`,
  };
}


function buildDexFunnel({snapshot,assets,preliminary,toConfirm,confirmed,valid}) {
  const dropReasons={
    noLiquidPool:0,
    screeningDenied:0,
    noCexBook:0,
    spreadBelowPreliminary:0,
    belowConfirmationThreshold:0,
    noQuoteAdapter:0,
    waitingConfirmationBudget:0,
    confirmationError:confirmed.filter((x)=>x.kind==='DEX_CEX_ERROR').length,
    nonPositiveAfterCosts:valid.filter((x)=>x.reason==='non_positive_net').length,
    knownNetworkRestriction:valid.filter((x)=>x.knownNetworkRestriction).length,
    rebalanceUnverified:valid.filter((x)=>x.rebalanceStatus==='unverified').length,
  };

  let screenedAllowed=0;
  let cexComparable=0;
  for (const asset of assets) {
    const key=exactIdentityKey(asset);
    const pool=state.poolsByIdentity.get(key);
    if (!pool) { dropReasons.noLiquidPool+=1; continue; }
    const meta=state.tokenMetaByIdentity.get(key);
    if (!screeningAllowed(meta?.screeningStatus)) { dropReasons.screeningDenied+=1; continue; }
    screenedAllowed+=1;
    if (!bestCexSides(snapshot,asset.cexSymbol)) { dropReasons.noCexBook+=1; continue; }
    cexComparable+=1;
    const routes=preliminary.filter((x)=>x.asset===asset);
    if (!routes.length) dropReasons.spreadBelowPreliminary+=1;
  }

  const strong=preliminary.filter((x)=>x.preliminarySpreadPct>=MIN_CONFIRM_SPREAD_PCT);
  dropReasons.belowConfirmationThreshold=preliminary.length-strong.length;
  const confirmable=strong.filter((x)=>Boolean(x.pool?.directAdapter||x.pool?.lifiToolKey));
  dropReasons.noQuoteAdapter=strong.length-confirmable.length;
  dropReasons.waitingConfirmationBudget=Math.max(0,confirmable.length-toConfirm.length);

  return {
    identities:assets.length,
    manualIdentities:DEX_ASSET_REGISTRY.length,
    autoVerifiedIdentities:state.autoAssets.length,
    withLiquidPool:state.poolsByIdentity.size,
    screenedAllowed,
    cexComparable,
    preliminaryRoutes:preliminary.length,
    strongRoutes:strong.length,
    directConfirmableRoutes:strong.filter((x)=>Boolean(x.pool?.directAdapter)).length,
    confirmableRoutes:confirmable.length,
    selectedForConfirmation:toConfirm.length,
    confirmedRoutes:valid.length,
    economicsPositiveRoutes:valid.filter((x)=>x.economicsEligible).length,
    operationalEligibleRoutes:valid.filter((x)=>x.eligible).length,
    dropReasons,
  };
}

export async function buildDexRadar({snapshot,budgetUsdt,costsForSymbol}) {
  await refreshTools().catch(()=>{});
  await refreshAutoRegistry();
  const assets=effectiveAssets();
  validateRegistry(assets);
  await Promise.all([refreshPools(),refreshTokenMetadata()]);
  const preliminary = preliminaryCandidates(snapshot,budgetUsdt);
  const strong=preliminary.filter((candidate)=>candidate.preliminarySpreadPct>=MIN_CONFIRM_SPREAD_PCT);
  const directCandidates=strong
    .filter((candidate)=>Boolean(candidate.pool?.directAdapter))
    .slice(0,MAX_DIRECT_CONFIRMATIONS);
  const directKeys=new Set(directCandidates.map((x)=>`${exactIdentityKey(x.asset)}:${x.direction}`));
  const fallbackCandidates=strong
    .filter((candidate)=>Boolean(candidate.pool?.lifiToolKey))
    .filter((candidate)=>!directKeys.has(`${exactIdentityKey(candidate.asset)}:${candidate.direction}`))
    .slice(0,MAX_FALLBACK_CONFIRMATIONS);
  const toConfirm=[...directCandidates,...fallbackCandidates];
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
    identityMethod:x.asset.identitySource==='manual_exact_contract'
      ? 'manual_cex_mapping+chainId+exact_dex_contract'
      : 'explicit_cex_mapping+uniswap_token_list+lifi_exact_contract_agreement',
    identitySource:x.asset.identitySource||'manual_exact_contract',
    cexContractVerified:null,
    cexIdentityConfidence:'manual_mapping_contract_unverified',
    dex:x.pool.dexId,
    poolLiquidityUsd:x.pool.liquidityUsd,
    poolVolume24hUsd:x.pool.volume24hUsd,
    pairUrl:x.pool.url,
    direction:x.direction,
    buyVenue:x.direction==='dex_to_cex' ? x.pool.dexId : x.cex.bestBuy.exchange,
    sellVenue:x.direction==='dex_to_cex' ? x.cex.bestSell.exchange : x.pool.dexId,
    preliminarySpreadPct:x.preliminarySpreadPct,
    quoteAdapter:x.pool.directAdapter||(x.pool.lifiToolKey?'lifi_fallback':null),
    status:'awaiting_executable_quote',
  }));

  const funnel=buildDexFunnel({snapshot,assets,preliminary,toConfirm,confirmed,valid});

  return {
    generatedAt:Date.now(),
    mode:'same-chain-read-only',
    chains:[...new Set(assets.map((x)=>chainForAsset(x)?.name).filter(Boolean))],
    curatedDexes:CURATED_DEX_NAMES,
    identityPolicy:'explicit CEX mapping + chainId + exact contract; auto expansion requires Uniswap token list and LI.FI exact-contract agreement; never arbitrary ticker-only',
    transferabilityVerified:false,
    minPoolLiquidityUsd:MIN_POOL_LIQUIDITY_USD,
    minPoolVolume24hUsd:MIN_POOL_VOLUME_24H_USD,
    registryAssets:assets.length,
    manualRegistryAssets:DEX_ASSET_REGISTRY.length,
    autoVerifiedAssets:state.autoAssets.length,
    autoAllowlistCandidates:AUTO_ASSET_ALLOWLIST.length,
    poolsFound:state.poolsByIdentity.size,
    directDex:directDexSnapshot(),
    lifiDexTools:state.toolKeys.length ? state.toolKeys : LIFI_TOOL_FALLBACK,
    executableDexes:[...new Set([...state.poolsByIdentity.values()].flatMap((pool)=>[pool.directAdapter,pool.lifiToolKey]).filter(Boolean))],
    funnel,
    preliminaryCount:preliminary.length,
    preliminaryTop5,
    confirmedCount:valid.length,
    positiveCount:valid.filter((x)=>x.eligible).length,
    economicsPositiveCount:valid.filter((x)=>x.economicsEligible).length,
    depthConfirmedCount:valid.filter((x)=>x.depthConfirmed).length,
    transferVerifiedCount:valid.filter((x)=>x.transferabilityVerified).length,
    top5:positives,
    nearest5:nearest,
    errors:confirmed.filter((x)=>x.kind==='DEX_CEX_ERROR').slice(0,5),
  };
}

export function dexRegistrySnapshot() {
  return effectiveAssets().map((asset)=>{
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
      identitySource:asset.identitySource||'manual_exact_contract',
      screeningStatus:state.tokenMetaByIdentity.get(exactIdentityKey(asset))?.screeningStatus || 'unknown',
      screeningSource:state.tokenMetaByIdentity.get(exactIdentityKey(asset))?.screeningSource || 'not_loaded',
      pool:state.poolsByIdentity.get(exactIdentityKey(asset)) || null,
    };
  });
}
