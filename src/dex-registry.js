export const DEX_CHAINS = Object.freeze({
  ethereum: Object.freeze({
    chainId: 1,
    dexScreenerChain: 'ethereum',
    name: 'Ethereum',
    quoteSymbol: 'USDT',
    quoteAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    quoteDecimals: 6,
  }),
  arbitrum: Object.freeze({
    chainId: 42161,
    dexScreenerChain: 'arbitrum',
    name: 'Arbitrum',
    quoteSymbol: 'USDT',
    quoteAddress: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    quoteDecimals: 6,
  }),
  base: Object.freeze({
    chainId: 8453,
    dexScreenerChain: 'base',
    name: 'Base',
    quoteSymbol: 'USDC',
    quoteAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    quoteDecimals: 6,
  }),
  polygon: Object.freeze({
    chainId: 137,
    dexScreenerChain: 'polygon',
    name: 'Polygon',
    quoteSymbol: 'USDT',
    quoteAddress: '0xc2132D05D31c914a87C6611C10748AaCBbB58e8F',
    quoteDecimals: 6,
  }),
  bsc: Object.freeze({
    chainId: 56,
    dexScreenerChain: 'bsc',
    name: 'BNB Chain',
    quoteSymbol: 'USDT',
    quoteAddress: '0x55d398326f99059fF775485246999027B3197955',
    quoteDecimals: 18,
  }),
});

export const CURATED_DEX_NAMES = Object.freeze([
  'Uniswap',
  'SushiSwap',
  'Curve',
  'Balancer',
  'PancakeSwap',
  'Camelot',
  'Aerodrome',
  'QuickSwap',
]);

export const CURATED_DEX_ID_ALIASES = Object.freeze([
  'uniswap',
  'sushiswap',
  'sushi',
  'curve',
  'balancer',
  'pancakeswap',
  'pancake',
  'camelot',
  'aerodrome',
  'quickswap',
  'quick',
]);

// Manual registry remains the highest-trust fallback. The CEX symbol is explicit
// and is never inferred from an arbitrary DEX ticker.
export const DEX_ASSET_REGISTRY = Object.freeze([
  Object.freeze({ canonicalId:'chainlink', cexSymbol:'LINKUSDT', symbol:'LINK', name:'Chainlink', chain:'ethereum', address:'0x514910771AF9Ca656af840dff83E8264EcF986CA', decimals:18, identitySource:'manual_exact_contract' }),
  Object.freeze({ canonicalId:'uniswap', cexSymbol:'UNIUSDT', symbol:'UNI', name:'Uniswap', chain:'ethereum', address:'0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', decimals:18, identitySource:'manual_exact_contract' }),
  Object.freeze({ canonicalId:'aave', cexSymbol:'AAVEUSDT', symbol:'AAVE', name:'Aave', chain:'ethereum', address:'0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9', decimals:18, identitySource:'manual_exact_contract' }),
  Object.freeze({ canonicalId:'curve-dao-token', cexSymbol:'CRVUSDT', symbol:'CRV', name:'Curve DAO', chain:'ethereum', address:'0xD533a949740bb3306d119CC777fa900bA034cd52', decimals:18, identitySource:'manual_exact_contract' }),
  Object.freeze({ canonicalId:'lido-dao', cexSymbol:'LDOUSDT', symbol:'LDO', name:'Lido DAO', chain:'ethereum', address:'0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32', decimals:18, identitySource:'manual_exact_contract' }),
  Object.freeze({ canonicalId:'shiba-inu', cexSymbol:'SHIBUSDT', symbol:'SHIB', name:'Shiba Inu', chain:'ethereum', address:'0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE', decimals:18, identitySource:'manual_exact_contract' }),
  Object.freeze({ canonicalId:'pepe', cexSymbol:'PEPEUSDT', symbol:'PEPE', name:'Pepe', chain:'ethereum', address:'0x6982508145454Ce325dDbE47a25d4ec3d2311933', decimals:18, identitySource:'manual_exact_contract' }),
  Object.freeze({ canonicalId:'arbitrum', cexSymbol:'ARBUSDT', symbol:'ARB', name:'Arbitrum', chain:'arbitrum', address:'0x912CE59144191C1204E64559FE8253a0e49E6548', decimals:18, identitySource:'manual_exact_contract' }),
  Object.freeze({ canonicalId:'chainlink', cexSymbol:'LINKUSDT', symbol:'LINK', name:'Chainlink', chain:'arbitrum', address:'0xf97f4df75117a78c1A5a0DBb814Af92458539FB4', decimals:18, identitySource:'manual_exact_contract' }),
  Object.freeze({ canonicalId:'uniswap', cexSymbol:'UNIUSDT', symbol:'UNI', name:'Uniswap', chain:'arbitrum', address:'0xfa7f8980b0f1e64a2062791cc3b0871572f1f7f0', decimals:18, identitySource:'manual_exact_contract' }),
]);

// Explicit CEX mappings eligible for automatic contract expansion. The address is
// NOT inferred from this ticker. Runtime expansion requires:
//   1) exactly one matching token on the official Uniswap token list for chain+symbol;
//   2) LI.FI to expose the exact same chainId+contract address;
//   3) a valid EVM contract + decimals.
// Anything ambiguous or mismatched is discarded.
export const AUTO_ASSET_ALLOWLIST = Object.freeze([
  // Ethereum
  { canonicalId:'compound-governance-token', symbol:'COMP', cexSymbol:'COMPUSDT', chain:'ethereum' },
  { canonicalId:'synthetix-network-token', symbol:'SNX', cexSymbol:'SNXUSDT', chain:'ethereum' },
  { canonicalId:'the-graph', symbol:'GRT', cexSymbol:'GRTUSDT', chain:'ethereum' },
  { canonicalId:'ethereum-name-service', symbol:'ENS', cexSymbol:'ENSUSDT', chain:'ethereum' },
  { canonicalId:'1inch', symbol:'1INCH', cexSymbol:'1INCHUSDT', chain:'ethereum' },
  { canonicalId:'sushi', symbol:'SUSHI', cexSymbol:'SUSHIUSDT', chain:'ethereum' },
  { canonicalId:'balancer', symbol:'BAL', cexSymbol:'BALUSDT', chain:'ethereum' },
  { canonicalId:'convex-finance', symbol:'CVX', cexSymbol:'CVXUSDT', chain:'ethereum' },
  { canonicalId:'yearn-finance', symbol:'YFI', cexSymbol:'YFIUSDT', chain:'ethereum' },
  { canonicalId:'frax-share', symbol:'FXS', cexSymbol:'FXSUSDT', chain:'ethereum' },
  { canonicalId:'apecoin', symbol:'APE', cexSymbol:'APEUSDT', chain:'ethereum' },
  { canonicalId:'immutable-x', symbol:'IMX', cexSymbol:'IMXUSDT', chain:'ethereum' },
  { canonicalId:'loopring', symbol:'LRC', cexSymbol:'LRCUSDT', chain:'ethereum' },
  { canonicalId:'basic-attention-token', symbol:'BAT', cexSymbol:'BATUSDT', chain:'ethereum' },
  { canonicalId:'0x', symbol:'ZRX', cexSymbol:'ZRXUSDT', chain:'ethereum' },
  { canonicalId:'mask-network', symbol:'MASK', cexSymbol:'MASKUSDT', chain:'ethereum' },
  { canonicalId:'ethena', symbol:'ENA', cexSymbol:'ENAUSDT', chain:'ethereum' },
  { canonicalId:'worldcoin', symbol:'WLD', cexSymbol:'WLDUSDT', chain:'ethereum' },
  { canonicalId:'blur', symbol:'BLUR', cexSymbol:'BLURUSDT', chain:'ethereum' },
  { canonicalId:'ether-fi', symbol:'ETHFI', cexSymbol:'ETHFIUSDT', chain:'ethereum' },
  { canonicalId:'eigenlayer', symbol:'EIGEN', cexSymbol:'EIGENUSDT', chain:'ethereum' },
  { canonicalId:'ondo-finance', symbol:'ONDO', cexSymbol:'ONDOUSDT', chain:'ethereum' },
  { canonicalId:'safe', symbol:'SAFE', cexSymbol:'SAFEUSDT', chain:'ethereum' },
  { canonicalId:'rocket-pool', symbol:'RPL', cexSymbol:'RPLUSDT', chain:'ethereum' },
  { canonicalId:'liquity', symbol:'LQTY', cexSymbol:'LQTYUSDT', chain:'ethereum' },
  { canonicalId:'ssv-network', symbol:'SSV', cexSymbol:'SSVUSDT', chain:'ethereum' },
  { canonicalId:'illuvium', symbol:'ILV', cexSymbol:'ILVUSDT', chain:'ethereum' },
  { canonicalId:'api3', symbol:'API3', cexSymbol:'API3USDT', chain:'ethereum' },
  { canonicalId:'spell-token', symbol:'SPELL', cexSymbol:'SPELLUSDT', chain:'ethereum' },
  { canonicalId:'usd-coin', symbol:'USDC', cexSymbol:'USDCUSDT', chain:'ethereum' },
  { canonicalId:'dai', symbol:'DAI', cexSymbol:'DAIUSDT', chain:'ethereum' },

  // Arbitrum
  { canonicalId:'aave', symbol:'AAVE', cexSymbol:'AAVEUSDT', chain:'arbitrum' },
  { canonicalId:'curve-dao-token', symbol:'CRV', cexSymbol:'CRVUSDT', chain:'arbitrum' },
  { canonicalId:'the-graph', symbol:'GRT', cexSymbol:'GRTUSDT', chain:'arbitrum' },
  { canonicalId:'sushi', symbol:'SUSHI', cexSymbol:'SUSHIUSDT', chain:'arbitrum' },
  { canonicalId:'balancer', symbol:'BAL', cexSymbol:'BALUSDT', chain:'arbitrum' },
  { canonicalId:'gmx', symbol:'GMX', cexSymbol:'GMXUSDT', chain:'arbitrum' },
  { canonicalId:'magic', symbol:'MAGIC', cexSymbol:'MAGICUSDT', chain:'arbitrum' },
  { canonicalId:'radiant-capital', symbol:'RDNT', cexSymbol:'RDNTUSDT', chain:'arbitrum' },
  { canonicalId:'pendle', symbol:'PENDLE', cexSymbol:'PENDLEUSDT', chain:'arbitrum' },
  { canonicalId:'usd-coin', symbol:'USDC', cexSymbol:'USDCUSDT', chain:'arbitrum' },
  { canonicalId:'dai', symbol:'DAI', cexSymbol:'DAIUSDT', chain:'arbitrum' },

  // Base — only identities that pass the same Uniswap-list + LI.FI exact-contract agreement enter runtime.
  { canonicalId:'aave', symbol:'AAVE', cexSymbol:'AAVEUSDT', chain:'base' },
  { canonicalId:'aerodrome-finance', symbol:'AERO', cexSymbol:'AEROUSDT', chain:'base' },
  { canonicalId:'virtual-protocol', symbol:'VIRTUAL', cexSymbol:'VIRTUALUSDT', chain:'base' },
  { canonicalId:'degen-base', symbol:'DEGEN', cexSymbol:'DEGENUSDT', chain:'base' },
  { canonicalId:'brett', symbol:'BRETT', cexSymbol:'BRETTUSDT', chain:'base' },
  { canonicalId:'usd-coin', symbol:'USDC', cexSymbol:'USDCUSDT', chain:'base' },

  // Polygon
  { canonicalId:'aave', symbol:'AAVE', cexSymbol:'AAVEUSDT', chain:'polygon' },
  { canonicalId:'chainlink', symbol:'LINK', cexSymbol:'LINKUSDT', chain:'polygon' },
  { canonicalId:'uniswap', symbol:'UNI', cexSymbol:'UNIUSDT', chain:'polygon' },
  { canonicalId:'the-graph', symbol:'GRT', cexSymbol:'GRTUSDT', chain:'polygon' },
  { canonicalId:'sushi', symbol:'SUSHI', cexSymbol:'SUSHIUSDT', chain:'polygon' },
  { canonicalId:'curve-dao-token', symbol:'CRV', cexSymbol:'CRVUSDT', chain:'polygon' },
  { canonicalId:'usd-coin', symbol:'USDC', cexSymbol:'USDCUSDT', chain:'polygon' },
  { canonicalId:'dai', symbol:'DAI', cexSymbol:'DAIUSDT', chain:'polygon' },

  // BNB Chain
  { canonicalId:'chainlink', symbol:'LINK', cexSymbol:'LINKUSDT', chain:'bsc' },
  { canonicalId:'uniswap', symbol:'UNI', cexSymbol:'UNIUSDT', chain:'bsc' },
  { canonicalId:'aave', symbol:'AAVE', cexSymbol:'AAVEUSDT', chain:'bsc' },
  { canonicalId:'the-graph', symbol:'GRT', cexSymbol:'GRTUSDT', chain:'bsc' },
  { canonicalId:'pancakeswap-token', symbol:'CAKE', cexSymbol:'CAKEUSDT', chain:'bsc' },
  { canonicalId:'1inch', symbol:'1INCH', cexSymbol:'1INCHUSDT', chain:'bsc' },
  { canonicalId:'usd-coin', symbol:'USDC', cexSymbol:'USDCUSDT', chain:'bsc' },
]);

export function normalizeAddress(address) {
  return String(address || '').toLowerCase();
}

export function chainForAsset(asset) {
  return DEX_CHAINS[asset?.chain] || null;
}

export function exactIdentityKey(asset) {
  const chain = chainForAsset(asset);
  if (!chain) return null;
  return `${chain.chainId}:${normalizeAddress(asset.address)}:${asset.cexSymbol}`;
}

export function isCuratedDexId(dexId) {
  const id = String(dexId || '').toLowerCase();
  return CURATED_DEX_ID_ALIASES.some((alias)=>id.includes(alias));
}

function listTokensForChainSymbol(tokens, chainId, symbol) {
  return (Array.isArray(tokens) ? tokens : []).filter((token)=>
    Number(token?.chainId) === Number(chainId)
    && String(token?.symbol || '').toUpperCase() === String(symbol || '').toUpperCase()
    && /^0x[0-9a-fA-F]{40}$/.test(String(token?.address || ''))
  );
}

export function buildAutoAssetRegistry({
  uniswapTokens = [],
  lifiTokens = [],
  allowlist = AUTO_ASSET_ALLOWLIST,
} = {}) {
  const out = [];
  const seen = new Set(DEX_ASSET_REGISTRY.map(exactIdentityKey));

  for (const spec of allowlist) {
    const chain = DEX_CHAINS[spec?.chain];
    if (!chain || !spec?.cexSymbol || !spec?.symbol) continue;

    const uniswapMatches = listTokensForChainSymbol(uniswapTokens, chain.chainId, spec.symbol);
    // Ambiguous symbols are intentionally rejected instead of guessing a token.
    if (uniswapMatches.length !== 1) continue;

    const token = uniswapMatches[0];
    const address = normalizeAddress(token.address);
    const lifiMatches = (Array.isArray(lifiTokens) ? lifiTokens : []).filter((candidate)=>
      Number(candidate?.chainId) === chain.chainId
      && normalizeAddress(candidate?.address) === address
    );
    if (!lifiMatches.length) continue;

    const decimals = Number(token.decimals);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) continue;

    const asset = Object.freeze({
      canonicalId: spec.canonicalId,
      cexSymbol: spec.cexSymbol,
      symbol: String(token.symbol).toUpperCase(),
      name: token.name || spec.canonicalId,
      chain: spec.chain,
      address: token.address,
      decimals,
      identitySource: 'uniswap_token_list+lifi_exact_contract_agreement',
    });

    const key = exactIdentityKey(asset);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(asset);
  }

  return out;
}

export function mergeAssetRegistries(staticAssets = DEX_ASSET_REGISTRY, autoAssets = []) {
  const out = [];
  const seen = new Set();
  for (const asset of [...staticAssets, ...autoAssets]) {
    const key = exactIdentityKey(asset);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(asset);
  }
  return out;
}

export function validateRegistry(assets = DEX_ASSET_REGISTRY) {
  const seen = new Set();
  for (const asset of assets) {
    const chain = chainForAsset(asset);
    if (!chain) throw new Error(`Unknown chain for ${asset.cexSymbol}`);
    if (!/^0x[0-9a-fA-F]{40}$/.test(asset.address)) throw new Error(`Invalid token address ${asset.cexSymbol}`);
    if (!/^[A-Z0-9]+USDT$/.test(String(asset.cexSymbol || ''))) throw new Error(`Invalid explicit CEX mapping ${asset.cexSymbol}`);
    const key = exactIdentityKey(asset);
    if (seen.has(key)) throw new Error(`Duplicate identity ${key}`);
    seen.add(key);
  }
  return true;
}
