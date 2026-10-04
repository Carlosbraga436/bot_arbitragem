import { chainForAsset, normalizeAddress } from './dex-registry.js';

const CACHE_MS=5*60_000;
const cache=new Map();

function normalizedLabel(value) {
  return String(value||'').toLowerCase().replace(/[^a-z0-9]/g,'');
}

function chainAliases(asset) {
  const chain=chainForAsset(asset);
  if (!chain) return [];
  if (chain.chainId===1) return ['eth','ethereum','erc20','etherc20','ethereumerc20'];
  if (chain.chainId===42161) return ['arb','arbitrum','arbitrumone','arbitrumonearb'];
  return [normalizedLabel(chain.name)];
}

export function chainEntryMatches(entry, asset) {
  const aliases=chainAliases(asset).map(normalizedLabel);
  const values=[
    entry?.chainId,
    entry?.chain,
    entry?.chainName,
    entry?.name,
  ].map(normalizedLabel).filter(Boolean);

  // Network labels must match an explicit normalized alias. Substring matching
  // is unsafe: e.g. "Asset Hub (Polkadot)" contains the letters "eth" across
  // "asset hub" and was previously misclassified as Ethereum.
  return aliases.some((alias)=>values.some((value)=>value===alias));
}

function contractVerification(entry, asset) {
  const raw=entry?.contractAddress ?? entry?.addr ?? entry?.contract_address ?? null;
  const contract=normalizeAddress(raw);
  const expected=normalizeAddress(asset?.address);
  if (!contract || contract==='0x') {
    return {
      contractVerified:null,
      contractStatus:'contract_not_exposed',
      contractAddress:raw||null,
    };
  }
  if (contract===expected) {
    return {
      contractVerified:true,
      contractStatus:'exact_contract_match',
      contractAddress:raw,
    };
  }
  return {
    contractVerified:false,
    contractStatus:'contract_mismatch',
    contractAddress:raw,
  };
}

async function fetchJson(url, timeoutMs=6000) {
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try {
    const r=await fetch(url,{
      signal:controller.signal,
      headers:{'user-agent':'radar-cripto-carlos-network/0.22.1'},
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
      return {source:url, ...parser(data)};
    } catch(error) {
      errors.push(`${url}: ${error?.message||error}`);
    }
  }
  throw new Error(errors.join(' | '));
}

async function kucoinNetwork(asset) {
  const currency=String(asset?.symbol||'').toUpperCase();
  const urls=[
    `https://api.kucoin.com/api/ua/v2/market/currency?currency=${encodeURIComponent(currency)}`,
    `https://api.kucoin.com/api/v3/currencies/${encodeURIComponent(currency)}`,
  ];

  const result=await fetchFirst(urls,(data)=>{
    if (data?.code!=='200000') throw new Error('kucoin_currency_response_invalid');
    const root=data?.data||{};
    const chains=Array.isArray(root?.list)
      ? root.list
      : (Array.isArray(root?.chains)?root.chains:[]);
    return {chains};
  });

  const entry=result.chains.find((x)=>chainEntryMatches(x,asset));
  if (!entry) {
    return {
      exchange:'kucoin',
      publicVerificationAvailable:true,
      networkMatched:false,
      contractVerified:null,
      depositEnabled:false,
      withdrawEnabled:false,
      status:'network_not_found',
      source:result.source,
    };
  }

  const contract=contractVerification(entry,asset);
  if (contract.contractVerified===false) {
    return {
      exchange:'kucoin',
      publicVerificationAvailable:true,
      networkMatched:true,
      depositEnabled:false,
      withdrawEnabled:false,
      status:'contract_mismatch',
      chainId:entry?.chainId||entry?.chain||null,
      chainName:entry?.chainName||null,
      ...contract,
      source:result.source,
    };
  }

  const depositEnabled=entry?.isDepositEnabled===true;
  const withdrawEnabled=entry?.isWithdrawEnabled===true;

  return {
    exchange:'kucoin',
    publicVerificationAvailable:true,
    networkMatched:true,
    depositEnabled,
    withdrawEnabled,
    status:depositEnabled && withdrawEnabled
      ? (contract.contractVerified===true?'deposit_withdraw_and_contract_verified':'deposit_withdraw_open_contract_unavailable')
      : 'network_restricted',
    chainId:entry?.chainId||entry?.chain||null,
    chainName:entry?.chainName||null,
    ...contract,
    withdrawMinFee:Number(entry?.withdrawMinFee??entry?.withdrawalMinFee??entry?.withdrawFee)||null,
    withdrawMinSize:Number(entry?.minWithdrawSize??entry?.withdrawMinSize??entry?.withdrawalMinSize)||null,
    source:result.source,
  };
}

async function gateNetwork(asset) {
  const currency=String(asset?.symbol||'').toUpperCase();
  const data=await fetchJson(`https://api.gateio.ws/api/v4/spot/currencies/${encodeURIComponent(currency)}`);
  const chains=Array.isArray(data?.chains)?data.chains:[];
  const entry=chains.find((x)=>chainEntryMatches(x,asset));

  if (!entry) {
    return {
      exchange:'gate',
      publicVerificationAvailable:true,
      networkMatched:false,
      contractVerified:null,
      depositEnabled:false,
      withdrawEnabled:false,
      status:'network_not_found',
      source:'gate_public_spot_currency_api',
    };
  }

  const contract=contractVerification(entry,asset);
  if (contract.contractVerified===false) {
    return {
      exchange:'gate',
      publicVerificationAvailable:true,
      networkMatched:true,
      depositEnabled:false,
      withdrawEnabled:false,
      status:'contract_mismatch',
      chainName:entry?.name||entry?.chain||null,
      ...contract,
      source:'gate_public_spot_currency_api',
    };
  }

  const depositEnabled=entry?.deposit_disabled===false;
  const withdrawEnabled=entry?.withdraw_disabled===false && entry?.withdraw_delayed!==true;

  return {
    exchange:'gate',
    publicVerificationAvailable:true,
    networkMatched:true,
    depositEnabled,
    withdrawEnabled,
    status:depositEnabled && withdrawEnabled
      ? (contract.contractVerified===true?'deposit_withdraw_and_contract_verified':'deposit_withdraw_open_contract_unavailable')
      : 'network_restricted',
    chainName:entry?.name||entry?.chain||null,
    ...contract,
    withdrawDelayed:entry?.withdraw_delayed===true,
    source:'gate_public_spot_currency_api',
  };
}

export async function validateCexNetwork(exchange, asset) {
  const ex=String(exchange||'').toLowerCase();
  const chain=chainForAsset(asset);
  const key=`${ex}:${chain?.chainId||'na'}:${normalizeAddress(asset?.address)}`;
  const cached=cache.get(key);
  if (cached && Date.now()-cached.fetchedAt<CACHE_MS) return cached.value;

  let value;
  if (ex==='kucoin' || ex==='gate') {
    try {
      value=ex==='kucoin'
        ? await kucoinNetwork(asset)
        : await gateNetwork(asset);
    } catch(error) {
      value={
        exchange:ex,
        publicVerificationAvailable:true,
        networkMatched:null,
        contractVerified:null,
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
      contractVerified:null,
      depositEnabled:null,
      withdrawEnabled:null,
      status:'not_verifiable_without_authenticated_exchange_api',
      note:'A execução com inventário pré-posicionado não exige transferência imediata; esta checagem é para rebalanceamento.',
    };
  }

  cache.set(key,{fetchedAt:Date.now(),value});
  return value;
}

export function transferActionStatus(network, action) {
  if (!network || (action!=='deposit' && action!=='withdraw')) return 'unverified';
  const enabled=action==='deposit' ? network.depositEnabled : network.withdrawEnabled;

  if (
    network.publicVerificationAvailable===true
    && network.networkMatched===true
    && network.contractVerified===true
    && enabled===true
  ) return 'verified_open';

  if (
    network.publicVerificationAvailable===true
    && (
      network.networkMatched===false
      || network.contractVerified===false
      || enabled===false
    )
  ) return 'restricted';

  return 'unverified';
}

export function transferStatusForRoute(network) {
  if (!network) return 'unverified';
  const deposit=transferActionStatus(network,'deposit');
  const withdraw=transferActionStatus(network,'withdraw');
  if (deposit==='restricted' || withdraw==='restricted') return 'restricted';
  if (deposit==='verified_open' && withdraw==='verified_open') return 'verified_open';
  return 'unverified';
}

export function rebalanceRequirementsForDirection(direction) {
  if (direction==='dex_to_cex') {
    return [
      { key:'token_to_cex', asset:'token', action:'deposit' },
      { key:'usdt_to_chain', asset:'quote', action:'withdraw' },
    ];
  }
  if (direction==='cex_to_dex') {
    return [
      { key:'token_to_chain', asset:'token', action:'withdraw' },
      { key:'usdt_to_cex', asset:'quote', action:'deposit' },
    ];
  }
  return [];
}

export function rebalanceStatusForRoute({direction,tokenNetwork,quoteNetwork}) {
  const requirements=rebalanceRequirementsForDirection(direction).map((requirement)=>{
    const network=requirement.asset==='token' ? tokenNetwork : quoteNetwork;
    return {
      ...requirement,
      status:transferActionStatus(network,requirement.action),
    };
  });

  const statuses=requirements.map((x)=>x.status);
  const status=statuses.includes('restricted')
    ? 'restricted'
    : (requirements.length>0 && statuses.every((x)=>x==='verified_open') ? 'verified_open' : 'unverified');

  return {
    status,
    requirements,
    verifiedRequirements:requirements.filter((x)=>x.status==='verified_open').length,
    totalRequirements:requirements.length,
  };
}

function quoteAssetFor(asset) {
  const chain=chainForAsset(asset);
  if (!chain) return null;
  return {
    canonicalId:'tether',
    cexSymbol:'USDT',
    symbol:'USDT',
    name:'Tether USD',
    chain:asset.chain,
    address:chain.quoteAddress,
    decimals:chain.quoteDecimals,
  };
}

export async function validateCexRebalance(exchange, asset, direction) {
  const quoteAsset=quoteAssetFor(asset);
  const [tokenNetwork,quoteNetwork]=await Promise.all([
    validateCexNetwork(exchange,asset),
    quoteAsset
      ? validateCexNetwork(exchange,quoteAsset)
      : Promise.resolve({
          exchange:String(exchange||'').toLowerCase(),
          publicVerificationAvailable:false,
          networkMatched:null,
          contractVerified:null,
          depositEnabled:null,
          withdrawEnabled:null,
          status:'quote_asset_chain_unavailable',
        }),
  ]);

  return {
    exchange:String(exchange||'').toLowerCase(),
    direction,
    tokenNetwork,
    quoteNetwork,
    ...rebalanceStatusForRoute({direction,tokenNetwork,quoteNetwork}),
  };
}
