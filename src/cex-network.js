import { chainForAsset, normalizeAddress } from './dex-registry.js';

const CACHE_MS=5*60_000;
const cache=new Map();

function chainAliases(asset) {
  const chain=chainForAsset(asset);
  if (!chain) return [];
  if (chain.chainId===1) return ['eth','ethereum','erc20'];
  if (chain.chainId===42161) return ['arb','arbitrum','arbitrum one'];
  return [String(chain.name||'').toLowerCase()];
}

function chainEntryMatches(entry, asset) {
  const aliases=chainAliases(asset);
  const hay=`${entry?.chainId||''} ${entry?.chainName||''}`.toLowerCase();
  const aliasMatch=aliases.some((alias)=>hay===alias||hay.includes(alias));
  const contract=normalizeAddress(entry?.contractAddress);
  const expected=normalizeAddress(asset?.address);
  const contractMatch=!contract || contract==='0x' || contract===expected;
  return aliasMatch && contractMatch;
}

async function fetchJson(url, timeoutMs=6000) {
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try {
    const r=await fetch(url,{
      signal:controller.signal,
      headers:{'user-agent':'radar-cripto-carlos-network/0.21'},
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

async function kucoinNetwork(asset) {
  const currency=String(asset?.symbol||'').toUpperCase();
  const data=await fetchJson(`https://api.kucoin.com/api/v3/currencies/${encodeURIComponent(currency)}`);
  if (data?.code!=='200000') throw new Error('kucoin_currency_response_invalid');
  const chains=Array.isArray(data?.data?.chains)?data.data.chains:[];
  const entry=chains.find((x)=>chainEntryMatches(x,asset));
  if (!entry) {
    return {
      exchange:'kucoin',
      publicVerificationAvailable:true,
      networkMatched:false,
      depositEnabled:false,
      withdrawEnabled:false,
      status:'network_not_found',
    };
  }
  return {
    exchange:'kucoin',
    publicVerificationAvailable:true,
    networkMatched:true,
    depositEnabled:entry?.isDepositEnabled===true,
    withdrawEnabled:entry?.isWithdrawEnabled===true,
    status:entry?.isDepositEnabled===true && entry?.isWithdrawEnabled===true
      ? 'deposit_and_withdraw_enabled'
      : 'network_restricted',
    chainId:entry?.chainId||null,
    chainName:entry?.chainName||null,
    contractAddress:entry?.contractAddress||null,
    withdrawMinFee:Number(entry?.withdrawMinFee??entry?.withdrawalMinFee)||null,
    withdrawMinSize:Number(entry?.withdrawMinSize??entry?.withdrawalMinSize)||null,
    source:'kucoin_public_currency_api',
  };
}

export async function validateCexNetwork(exchange, asset) {
  const ex=String(exchange||'').toLowerCase();
  const chain=chainForAsset(asset);
  const key=`${ex}:${chain?.chainId||'na'}:${normalizeAddress(asset?.address)}`;
  const cached=cache.get(key);
  if (cached && Date.now()-cached.fetchedAt<CACHE_MS) return cached.value;

  let value;
  if (ex==='kucoin') {
    try {
      value=await kucoinNetwork(asset);
    } catch(error) {
      value={
        exchange:ex,
        publicVerificationAvailable:true,
        networkMatched:false,
        depositEnabled:null,
        withdrawEnabled:null,
        status:'public_check_failed',
        error:error?.message||String(error),
      };
    }
  } else {
    value={
      exchange:ex,
      publicVerificationAvailable:false,
      networkMatched:null,
      depositEnabled:null,
      withdrawEnabled:null,
      status:'not_verifiable_without_authenticated_exchange_api',
      note:'A execução com inventário pré-posicionado não exige transferência imediata; esta checagem é para rebalanceamento.',
    };
  }

  cache.set(key,{fetchedAt:Date.now(),value});
  return value;
}

export function transferStatusForRoute(network) {
  if (!network) return 'unverified';
  if (network.publicVerificationAvailable && network.networkMatched && network.depositEnabled && network.withdrawEnabled) return 'verified_open';
  if (network.publicVerificationAvailable && (network.depositEnabled===false || network.withdrawEnabled===false)) return 'restricted';
  return 'unverified';
}
