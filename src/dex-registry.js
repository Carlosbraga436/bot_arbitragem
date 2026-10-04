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
});

export const CURATED_DEX_NAMES = Object.freeze([
  'Uniswap',
  'SushiSwap',
  'Curve',
  'Balancer',
  'PancakeSwap',
  'Camelot',
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
]);

// Manual identity registry. The CEX symbol is never inferred from the token ticker.
// A DEX asset is eligible only when chainId + exact contract address matches this registry.
export const DEX_ASSET_REGISTRY = Object.freeze([
  Object.freeze({ canonicalId:'chainlink', cexSymbol:'LINKUSDT', symbol:'LINK', name:'Chainlink', chain:'ethereum', address:'0x514910771AF9Ca656af840dff83E8264EcF986CA', decimals:18 }),
  Object.freeze({ canonicalId:'uniswap', cexSymbol:'UNIUSDT', symbol:'UNI', name:'Uniswap', chain:'ethereum', address:'0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', decimals:18 }),
  Object.freeze({ canonicalId:'aave', cexSymbol:'AAVEUSDT', symbol:'AAVE', name:'Aave', chain:'ethereum', address:'0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9', decimals:18 }),
  Object.freeze({ canonicalId:'curve-dao-token', cexSymbol:'CRVUSDT', symbol:'CRV', name:'Curve DAO', chain:'ethereum', address:'0xD533a949740bb3306d119CC777fa900bA034cd52', decimals:18 }),
  Object.freeze({ canonicalId:'lido-dao', cexSymbol:'LDOUSDT', symbol:'LDO', name:'Lido DAO', chain:'ethereum', address:'0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32', decimals:18 }),
  Object.freeze({ canonicalId:'shiba-inu', cexSymbol:'SHIBUSDT', symbol:'SHIB', name:'Shiba Inu', chain:'ethereum', address:'0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE', decimals:18 }),
  Object.freeze({ canonicalId:'pepe', cexSymbol:'PEPEUSDT', symbol:'PEPE', name:'Pepe', chain:'ethereum', address:'0x6982508145454Ce325dDbE47a25d4ec3d2311933', decimals:18 }),
  Object.freeze({ canonicalId:'arbitrum', cexSymbol:'ARBUSDT', symbol:'ARB', name:'Arbitrum', chain:'arbitrum', address:'0x912CE59144191C1204E64559FE8253a0e49E6548', decimals:18 }),
  Object.freeze({ canonicalId:'chainlink', cexSymbol:'LINKUSDT', symbol:'LINK', name:'Chainlink', chain:'arbitrum', address:'0xf97f4df75117a78c1A5a0DBb814Af92458539FB4', decimals:18 }),
  Object.freeze({ canonicalId:'uniswap', cexSymbol:'UNIUSDT', symbol:'UNI', name:'Uniswap', chain:'arbitrum', address:'0xfa7f8980b0f1e64a2062791cc3b0871572f1f7f0', decimals:18 }),
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

export function validateRegistry() {
  const seen = new Set();
  for (const asset of DEX_ASSET_REGISTRY) {
    const chain = chainForAsset(asset);
    if (!chain) throw new Error(`Unknown chain for ${asset.cexSymbol}`);
    if (!/^0x[0-9a-fA-F]{40}$/.test(asset.address)) throw new Error(`Invalid token address ${asset.cexSymbol}`);
    const key = exactIdentityKey(asset);
    if (seen.has(key)) throw new Error(`Duplicate identity ${key}`);
    seen.add(key);
  }
  return true;
}
