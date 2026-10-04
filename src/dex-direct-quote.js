const DIRECT_QUOTE_CACHE_MS = 30_000;
const GAS_PRICE_CACHE_MS = 15_000;

const RPC_ENDPOINTS = Object.freeze({
  ethereum: process.env.ETHEREUM_RPC_URL || 'https://ethereum-rpc.publicnode.com',
  arbitrum: process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc',
});

const UNISWAP_V3_QUOTER_V2 = Object.freeze({
  ethereum: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  arbitrum: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
});

const SUSHISWAP_V2_ROUTER = Object.freeze({
  ethereum: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F',
  arbitrum: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
});

const CAMELOT_V2_ROUTER = Object.freeze({
  arbitrum: '0xc873fEcbd354f5A56E00E710B90EF4201db2448d',
});

const UNISWAP_FEE_TIERS = Object.freeze([100, 500, 3000, 10000]);
const UNISWAP_QUOTE_SELECTOR = 'c6a5026a';
const V2_GET_AMOUNTS_OUT_SELECTOR = 'd06ca61f';

const quoteCache = new Map();
const gasPriceCache = new Map();
let rpcId = 1;

function normalizeAddress(address) {
  const value = String(address || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(value)) throw new Error('invalid_evm_address');
  return value;
}

function hexWord(value) {
  const n = BigInt(value);
  if (n < 0n) throw new Error('negative_abi_word');
  return n.toString(16).padStart(64, '0');
}

function addressWord(address) {
  return normalizeAddress(address).slice(2).padStart(64, '0');
}

function cleanHex(value) {
  const hex = String(value || '');
  if (!/^0x[0-9a-fA-F]*$/.test(hex)) throw new Error('invalid_rpc_hex');
  return hex.slice(2);
}

function readWord(hex, index) {
  const clean = cleanHex(hex);
  const start = index * 64;
  const word = clean.slice(start, start + 64);
  if (word.length !== 64) throw new Error('short_rpc_result');
  return BigInt(`0x${word}`);
}

export function encodeUniswapQuoteExactInputSingle({ tokenIn, tokenOut, amountIn, fee }) {
  return `0x${UNISWAP_QUOTE_SELECTOR}${addressWord(tokenIn)}${addressWord(tokenOut)}${hexWord(amountIn)}${hexWord(fee)}${hexWord(0)}`;
}

export function encodeV2GetAmountsOut({ tokenIn, tokenOut, amountIn }) {
  return `0x${V2_GET_AMOUNTS_OUT_SELECTOR}${hexWord(amountIn)}${hexWord(64)}${hexWord(2)}${addressWord(tokenIn)}${addressWord(tokenOut)}`;
}

export function decodeV2AmountsOut(result) {
  const offset = Number(readWord(result, 0));
  if (offset !== 32) throw new Error('unexpected_v2_array_offset');
  const length = Number(readWord(result, 1));
  if (length < 2) throw new Error('short_v2_amounts');
  const amounts = [];
  for (let i = 0; i < length; i += 1) amounts.push(readWord(result, 2 + i));
  return amounts;
}

export function applyDirectSlippage(amountOut, slippageBps = 50) {
  const amount = BigInt(amountOut);
  const bps = BigInt(Math.max(0, Math.min(5000, Math.floor(Number(slippageBps) || 0))));
  return amount * (10_000n - bps) / 10_000n;
}

async function rpc(chainKey, method, params, timeoutMs = 7_000) {
  const endpoint = RPC_ENDPOINTS[chainKey];
  if (!endpoint) throw new Error(`rpc_not_configured:${chainKey}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'user-agent': 'radar-cripto-carlos-direct-dex/0.22',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: rpcId++,
        method,
        params,
      }),
    });
    if (!response.ok) throw new Error(`rpc_http_${response.status}`);
    const body = await response.json();
    if (body?.error) throw new Error(`rpc_error:${body.error?.code || ''}:${body.error?.message || 'unknown'}`);
    if (body?.result == null) throw new Error('rpc_empty_result');
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

async function gasPriceWei(chainKey) {
  const cached = gasPriceCache.get(chainKey);
  if (cached && Date.now() - cached.fetchedAt < GAS_PRICE_CACHE_MS) return cached.value;
  const raw = await rpc(chainKey, 'eth_gasPrice', []);
  const value = BigInt(raw);
  gasPriceCache.set(chainKey, { value, fetchedAt: Date.now() });
  return value;
}

async function ethCall(chainKey, to, data) {
  return rpc(chainKey, 'eth_call', [{ to, data }, 'latest']);
}

async function quoteUniswapV3({ chainKey, tokenIn, tokenOut, amountIn }) {
  const quoter = UNISWAP_V3_QUOTER_V2[chainKey];
  if (!quoter) throw new Error(`uniswap_v3_not_deployed:${chainKey}`);

  const attempts = await Promise.allSettled(
    UNISWAP_FEE_TIERS.map(async (fee) => {
      const data = encodeUniswapQuoteExactInputSingle({ tokenIn, tokenOut, amountIn, fee });
      const result = await ethCall(chainKey, quoter, data);
      const amountOut = readWord(result, 0);
      const gasEstimate = readWord(result, 3);
      if (amountOut <= 0n) throw new Error(`empty_uniswap_quote:${fee}`);
      return { amountOut, gasEstimate, fee };
    }),
  );

  const valid = attempts
    .filter((x) => x.status === 'fulfilled')
    .map((x) => x.value)
    .sort((a, b) => (a.amountOut === b.amountOut ? 0 : (a.amountOut > b.amountOut ? -1 : 1)));

  if (!valid.length) {
    const reasons = attempts
      .filter((x) => x.status === 'rejected')
      .map((x) => x.reason?.message || String(x.reason))
      .slice(0, 4)
      .join('|');
    throw new Error(`uniswap_direct_quote_failed:${reasons || 'no_pool'}`);
  }

  const best = valid[0];
  return {
    adapter: 'uniswap_v3_quoter',
    protocol: 'uniswap',
    amountOut: best.amountOut,
    gasEstimate: best.gasEstimate || 220_000n,
    feeTier: best.fee,
    contract: quoter,
  };
}

async function quoteV2Router({ chainKey, tokenIn, tokenOut, amountIn, router, adapter, protocol }) {
  if (!router) throw new Error(`${protocol}_v2_not_deployed:${chainKey}`);
  const data = encodeV2GetAmountsOut({ tokenIn, tokenOut, amountIn });
  const result = await ethCall(chainKey, router, data);
  const amounts = decodeV2AmountsOut(result);
  const amountOut = amounts[amounts.length - 1];
  if (amountOut <= 0n) throw new Error(`${protocol}_direct_quote_empty`);
  return {
    adapter,
    protocol,
    amountOut,
    // Conservative read-only planning estimate. Actual execution gas can vary.
    gasEstimate: 240_000n,
    contract: router,
  };
}

export function directDexAdapterFor(dexId, chainKey) {
  const id = String(dexId || '').toLowerCase();
  if (!id) return null;
  if (id.includes('uniswap') && UNISWAP_V3_QUOTER_V2[chainKey]) return 'uniswap_v3_quoter';
  if ((id.includes('sushiswap') || id === 'sushi' || id.includes('sushi')) && SUSHISWAP_V2_ROUTER[chainKey]) return 'sushiswap_v2_router';
  if (id.includes('camelot') && CAMELOT_V2_ROUTER[chainKey]) return 'camelot_v2_router';
  return null;
}

export async function directDexQuote({ dexId, chainKey, tokenIn, tokenOut, amountIn }) {
  const adapter = directDexAdapterFor(dexId, chainKey);
  if (!adapter) throw new Error('direct_dex_adapter_unavailable');

  const key = [
    adapter,
    chainKey,
    normalizeAddress(tokenIn),
    normalizeAddress(tokenOut),
    String(amountIn),
  ].join(':');
  const cached = quoteCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < DIRECT_QUOTE_CACHE_MS) return cached.value;

  let quote;
  if (adapter === 'uniswap_v3_quoter') {
    quote = await quoteUniswapV3({ chainKey, tokenIn, tokenOut, amountIn });
  } else if (adapter === 'sushiswap_v2_router') {
    quote = await quoteV2Router({
      chainKey,
      tokenIn,
      tokenOut,
      amountIn,
      router: SUSHISWAP_V2_ROUTER[chainKey],
      adapter,
      protocol: 'sushiswap',
    });
  } else if (adapter === 'camelot_v2_router') {
    quote = await quoteV2Router({
      chainKey,
      tokenIn,
      tokenOut,
      amountIn,
      router: CAMELOT_V2_ROUTER[chainKey],
      adapter,
      protocol: 'camelot',
    });
  } else {
    throw new Error('direct_dex_adapter_not_implemented');
  }

  const gasPrice = await gasPriceWei(chainKey);
  const value = {
    ...quote,
    gasPriceWei: gasPrice,
    quotedAt: Date.now(),
    source: 'direct_onchain_eth_call',
  };
  quoteCache.set(key, { value, fetchedAt: Date.now() });
  return value;
}

export function directDexSnapshot() {
  return {
    rpcChains: Object.keys(RPC_ENDPOINTS),
    adapters: {
      uniswap: Object.keys(UNISWAP_V3_QUOTER_V2),
      sushiswap: Object.keys(SUSHISWAP_V2_ROUTER),
      camelot: Object.keys(CAMELOT_V2_ROUTER),
    },
    mode: 'read_only_eth_call',
  };
}
