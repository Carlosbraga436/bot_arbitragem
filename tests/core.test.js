import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOrderBookMessage, evaluateAcrossExchanges, evaluatePair, evaluateRoute, topPositive } from '../src/core.js';
import { AUTO_ASSET_ALLOWLIST, DEX_ASSET_REGISTRY, DEX_CHAINS, buildAutoAssetRegistry, exactIdentityKey, mergeAssetRegistries, validateRegistry } from '../src/dex-registry.js';
import { applyDirectSlippage, decodeV2AmountsOut, directDexAdapterFor, encodeUniswapQuoteExactInputSingle, encodeV2GetAmountsOut } from '../src/dex-direct-quote.js';
import { capacitySearchBudgets, poolReferenceIsTrusted } from '../src/dex-radar.js';
import { cexSymbolFormat, depthCapacity } from '../src/cex-depth.js';
import { chainEntryMatches, rebalanceStatusForRoute, transferActionStatus, transferStatusForRoute } from '../src/cex-network.js';
import { BINANCE_DISCOVERY_STREAM, buildCommonUsdtMarkets, buildMultiExchangeUniverse, chunkTopics, createMarketHub, MAX_MONITORED_SYMBOLS, selectConfirmedSymbols, selectDiscoveredBinanceSymbols } from '../src/market-hub.js';

const now = 1_800_000_000_000;
const book = (bid, ask, qty=1000, ts=now) => ({ bids:[[String(bid),String(qty)]], asks:[[String(ask),String(qty)]], ts });
const costs = { binanceFeePct:0.1, bybitFeePct:0.1, reservePct:0.05, recompositionUsdt:0.5 };
const rules = { maxAgeMs:5000, maxSkewMs:2000, minBudgetFillPct:100 };

test('bloqueia identidade não confirmada', () => {
  const r = evaluateRoute({ symbol:'ABCUSDT', identityConfirmed:false, buyExchange:'binance', sellExchange:'bybit', buyBook:book(9.9,10), sellBook:book(10.2,10.3), budgetUsdt:100, costs, rules, now });
  assert.equal(r.eligible,false); assert.equal(r.reason,'identity_unconfirmed');
});

test('bloqueia dado stale', () => {
  const r = evaluateRoute({ symbol:'BTCUSDT', identityConfirmed:true, buyExchange:'binance', sellExchange:'bybit', buyBook:book(99,100,1000,now-6000), sellBook:book(102,103), budgetUsdt:100, costs, rules, now });
  assert.equal(r.eligible,false); assert.equal(r.reason,'stale_data');
});

test('bloqueia liquidez insuficiente na compra', () => {
  const r = evaluateRoute({ symbol:'BTCUSDT', identityConfirmed:true, buyExchange:'binance', sellExchange:'bybit', buyBook:book(99,100,0.2), sellBook:book(110,111,1000), budgetUsdt:100, costs, rules, now });
  assert.equal(r.eligible,false); assert.equal(r.reason,'insufficient_buy_liquidity');
});

test('taxas + reserva transformam spread bruto pequeno em resultado de execução não positivo', () => {
  const r = evaluateRoute({ symbol:'BTCUSDT', identityConfirmed:true, buyExchange:'binance', sellExchange:'bybit', buyBook:book(99.8,100), sellBook:book(100.2,100.3), budgetUsdt:100, costs, rules, now });
  assert.ok(r.grossPnlUsdt > 0); assert.ok(r.netPnlUsdt < 0); assert.equal(r.eligible,false);
});

test('recomposição é cenário separado e não bloqueia execução positiva', () => {
  const r = evaluateRoute({ symbol:'BTCUSDT', identityConfirmed:true, buyExchange:'binance', sellExchange:'bybit', buyBook:book(99.8,100), sellBook:book(100.5,100.6), budgetUsdt:100, costs, rules, now });
  assert.ok(r.executionNetPnlUsdt > 0);
  assert.ok(r.netAfterRebalanceUsdt < 0);
  assert.equal(r.netPnlUsdt, r.executionNetPnlUsdt);
  assert.equal(r.eligible,true);
  assert.equal(r.eligibilityModel,'execution_net_before_rebalance');
});

test('spread suficiente gera resultado líquido positivo', () => {
  const r = evaluateRoute({ symbol:'BTCUSDT', identityConfirmed:true, buyExchange:'binance', sellExchange:'bybit', buyBook:book(99,100), sellBook:book(103,104), budgetUsdt:100, costs, rules, now });
  assert.ok(r.netPnlUsdt > 0); assert.equal(r.eligible,true);
});

test('evaluatePair escolhe a melhor direção sem misturar símbolo', () => {
  const r = evaluatePair({ symbol:'ETHUSDT', identityConfirmed:true, binanceBook:book(99,100), bybitBook:book(103,104), budgetUsdt:100, costs, rules, now });
  assert.equal(r.symbol,'ETHUSDT'); assert.equal(r.buyExchange,'binance'); assert.equal(r.sellExchange,'bybit');
});

test('topPositive mantém apenas positivas e limita top 5', () => {
  const list = Array.from({length:7},(_,i)=>({eligible:true,netPnlUsdt:i+1,symbol:`S${i}`}));
  const top = topPositive([...list,{eligible:false,netPnlUsdt:99,symbol:'BAD'}],5);
  assert.deepEqual(top.map(x=>x.netPnlUsdt),[7,6,5,4,3]);
});

test('Bybit depth 50 aplica snapshot e delta sem tratar delta como livro completo', () => {
  const snap = applyOrderBookMessage(null, { bids:[["100","2"],["99","3"]], asks:[["101","2"],["102","4"]], ts:now }, 'snapshot', 50);
  const next = applyOrderBookMessage(snap, { bids:[["100","0"],["98","5"]], asks:[["101","7"]], ts:now+10 }, 'delta', 50);
  assert.deepEqual(next.bids, [[99,3],[98,5]]);
  assert.deepEqual(next.asks, [[101,7],[102,4]]);
});


test('market hub inicia em estado seguro e expõe símbolos sem credenciais', () => {
  const hub = createMarketHub({ symbols:['BTCUSDT'], logger:{ info(){}, warn(){} } });
  const snap = hub.snapshot();
  assert.deepEqual(snap.symbols,['BTCUSDT']);
  assert.equal(snap.status.binance.state,'idle');
  assert.equal(snap.status.bybit.state,'idle');
  assert.deepEqual(snap.books.binance,{});
  assert.deepEqual(snap.books.bybit,{});
});


test('Bybit spot divide tópicos em lotes de no máximo 10', () => {
  const topics = Array.from({ length: 25 }, (_, i) => `tickers.S${i}USDT`);
  const chunks = chunkTopics(topics);
  assert.deepEqual(chunks.map((x) => x.length), [10, 10, 5]);
  assert.deepEqual(chunks.flat(), topics);
  assert.ok(chunks.every((x) => x.length <= 10));
});


test('seleção monitorada inclui apenas identidades confirmadas até o teto', () => {
  const candidates = [
    { symbol:'BTCUSDT', identityConfirmed:true },
    { symbol:'ETHUSDT', identityConfirmed:true },
    { symbol:'TONUSDT', identityConfirmed:false },
    { symbol:'SHIBUSDT', identityConfirmed:true },
    { symbol:'AAVEUSDT', identityConfirmed:true },
  ];
  const selected = selectConfirmedSymbols(candidates, 4);
  assert.deepEqual(selected, ['AAVEUSDT','BTCUSDT','ETHUSDT','SHIBUSDT']);
  assert.ok(!selected.includes('TONUSDT'));
});

test('catálogo dinâmico mantém somente par USDT ativo e idêntico nas duas exchanges', () => {
  const markets = buildCommonUsdtMarkets({
    binanceSymbols:[
      {symbol:'ABCUSDT',baseAsset:'ABC',quoteAsset:'USDT',status:'TRADING'},
      {symbol:'DEFUSDT',baseAsset:'DEF',quoteAsset:'USDT',status:'TRADING'},
      {symbol:'OLDUSDT',baseAsset:'OLD',quoteAsset:'USDT',status:'BREAK'},
    ],
    bybitSymbols:[
      {symbol:'ABCUSDT',baseCoin:'ABC',quoteCoin:'USDT',status:'Trading'},
      {symbol:'DEFUSDT',baseCoin:'DIFFERENT',quoteCoin:'USDT',status:'Trading'},
      {symbol:'XYZUSDT',baseCoin:'XYZ',quoteCoin:'USDT',status:'Trading'},
    ],
  });
  assert.deepEqual(markets.map((x)=>x.symbol), ['ABCUSDT']);
  assert.equal(markets[0].identityConfirmed, true);
});

test('teto amplo cobre mais de dois mil candidatos sem assinar símbolos inválidos na Binance', () => {
  assert.ok(MAX_MONITORED_SYMBOLS >= 2000);
  assert.equal(BINANCE_DISCOVERY_STREAM,'!miniTicker@arr');
  const monitored=['BTCUSDT','ETHUSDT','ONLYOTHERUSDT'];
  const discovered=selectDiscoveredBinanceSymbols(
    [{s:'BTCUSDT'},{s:'ETHUSDT'},{s:'BNBBTC'},{s:'NOTMONITOREDUSDT'}],
    monitored,
  );
  assert.deepEqual(discovered,['BTCUSDT','ETHUSDT']);
});


test('modo hospedado usa universo Bybit e exige confirmação live implícita pela presença de books', () => {
  const markets = buildCommonUsdtMarkets({
    bybitSymbols:[
      {symbol:'ABCUSDT',baseCoin:'ABC',quoteCoin:'USDT',status:'Trading'},
      {symbol:'XYZUSDT',baseCoin:'XYZ',quoteCoin:'USDT',status:'Trading'},
      {symbol:'PAUSEDUSDT',baseCoin:'PAUSED',quoteCoin:'USDT',status:'PreLaunch'},
    ],
  });
  assert.deepEqual(markets.map((x)=>x.symbol), ['ABCUSDT','XYZUSDT']);
  assert.equal(markets[0].identityMethod, 'bybit_catalog+exact_symbol_live_probe_on_binance');
});


test('evaluateAcrossExchanges escolhe a melhor rota entre quatro exchanges', () => {
  const multiCosts = {
    exchangeFeePct:{binance:0.1,bybit:0.1,okx:0.1,gate:0.1},
    reservePct:0.05,
    recompositionUsdt:0.5,
  };
  const r = evaluateAcrossExchanges({
    symbol:'ABCUSDT',
    identityConfirmed:true,
    booksByExchange:{
      binance:book(99.9,100),
      bybit:book(101.0,101.1),
      okx:book(100.4,100.5),
      gate:book(101.5,101.6),
    },
    budgetUsdt:100,
    costs:multiCosts,
    rules,
    now,
  });
  assert.equal(r.buyExchange,'binance');
  assert.equal(r.sellExchange,'gate');
  assert.ok(r.netPnlUsdt > 0);
});

test('taxa específica da OKX é aplicada à rota', () => {
  const multiCosts = {
    exchangeFeePct:{binance:0.1,bybit:0.1,okx:0.1,gate:0.1},
    reservePct:0,
    recompositionUsdt:0,
  };
  const r = evaluateRoute({
    symbol:'ABCUSDT',
    identityConfirmed:true,
    buyExchange:'okx',
    sellExchange:'gate',
    buyBook:book(99.9,100),
    sellBook:book(101,101.1),
    budgetUsdt:100,
    costs:multiCosts,
    rules,
    now,
  });
  assert.ok(r.tradingFeesUsdt > 0.19 && r.tradingFeesUsdt < 0.21);
});

test('universo multiexchange une pares USDT ativos sem duplicar símbolo', () => {
  const markets = buildMultiExchangeUniverse({
    bybitSymbols:[
      {symbol:'BTCUSDT',baseCoin:'BTC',quoteCoin:'USDT',status:'Trading'},
      {symbol:'SOLUSDT',baseCoin:'SOL',quoteCoin:'USDT',status:'Trading'},
    ],
    okxSymbols:[
      {instId:'BTC-USDT',baseCcy:'BTC',quoteCcy:'USDT',state:'live'},
      {instId:'ETH-USDT',baseCcy:'ETH',quoteCcy:'USDT',state:'live'},
    ],
    gateSymbols:[
      {id:'BTC_USDT',base:'BTC',quote:'USDT',trade_status:'tradable'},
      {id:'XRP_USDT',base:'XRP',quote:'USDT',trade_status:'tradable'},
    ],
  });
  assert.deepEqual(markets.map((x)=>x.symbol), ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT']);
  const btc = markets.find((x)=>x.symbol==='BTCUSDT');
  assert.equal(btc.catalogVenueCount,3);
  assert.equal(btc.venues.bybit,true);
  assert.equal(btc.venues.okx,true);
  assert.equal(btc.venues.gate,true);
});

test('market hub seguro expõe as cinco exchanges antes de iniciar', () => {
  const hub = createMarketHub({ symbols:['BTCUSDT'], gateSymbols:['BTCUSDT'], logger:{info(){},warn(){}} });
  const snap = hub.snapshot();
  assert.deepEqual(Object.keys(snap.status), ['binance','bybit','okx','gate','kucoin']);
  assert.deepEqual(Object.keys(snap.books), ['binance','bybit','okx','gate','kucoin']);
  assert.equal(snap.status.okx.state,'idle');
  assert.equal(snap.status.gate.state,'idle');
  assert.equal(snap.status.kucoin.state,'idle');
});


test('bloqueia dislocação extrema não validada antes do Top 5', () => {
  const r = evaluateRoute({
    symbol:'ONEUSDT',
    identityConfirmed:true,
    buyExchange:'gate',
    sellExchange:'binance',
    buyBook:book(1.0,1.0,1000),
    sellBook:book(1.4,1.41,1000),
    budgetUsdt:100,
    costs:{
      exchangeFeePct:{gate:0.1,binance:0.1},
      reservePct:0.05,
      recompositionUsdt:0.5,
    },
    rules:{...rules,maxUnverifiedGrossSpreadPct:10},
    now,
  });
  assert.equal(r.eligible,false);
  assert.equal(r.reason,'price_anomaly_unverified');
  assert.ok(r.grossSpreadPct > 10);
});


test('consenso de 3+ exchanges remove venue isolada com preço divergente', () => {
  const r = evaluateAcrossExchanges({
    symbol:'ZILUSDT',
    identityConfirmed:true,
    booksByExchange:{
      binance:book(0.00349,0.00350,100000),
      bybit:book(0.00348,0.00349,100000),
      okx:book(0.00318,0.00319,100000),
      gate:book(0.00350,0.00351,100000),
    },
    budgetUsdt:100,
    costs:{
      exchangeFeePct:{binance:0.1,bybit:0.1,okx:0.1,gate:0.1},
      reservePct:0.05,
      recompositionUsdt:0.5,
    },
    rules:{...rules,maxVenueDeviationPct:3,maxUnverifiedGrossSpreadPct:10},
    now,
  });
  assert.notEqual(r.buyExchange,'okx');
});

test('consenso não bloqueia rota normal entre venues alinhadas', () => {
  const r = evaluateAcrossExchanges({
    symbol:'ABCUSDT',
    identityConfirmed:true,
    booksByExchange:{
      binance:book(99.9,100),
      bybit:book(100.8,100.9),
      okx:book(100.2,100.3),
    },
    budgetUsdt:100,
    costs:{
      exchangeFeePct:{binance:0.1,bybit:0.1,okx:0.1},
      reservePct:0.05,
      recompositionUsdt:0.5,
    },
    rules:{...rules,maxVenueDeviationPct:3,maxUnverifiedGrossSpreadPct:10},
    now,
  });
  assert.equal(r.buyExchange,'binance');
  assert.equal(r.sellExchange,'bybit');
});


test('universo multiexchange inclui KuCoin e deriva taxa VIP0 por classe do par', () => {
  const markets = buildMultiExchangeUniverse({
    kucoinSymbols:[
      {
        symbol:'BTC-USDT',
        baseCurrency:'BTC',
        quoteCurrency:'USDT',
        tradingStatus:'TradingEnabled',
        feeCategory:'classA',
        takerFeeCoefficient:'1.00',
      },
      {
        symbol:'ABC-USDT',
        baseCurrency:'ABC',
        quoteCurrency:'USDT',
        tradingStatus:'TradingEnabled',
        feeCategory:'classC',
        takerFeeCoefficient:'1.00',
      },
    ],
  });
  const btc = markets.find((x)=>x.symbol==='BTCUSDT');
  const abc = markets.find((x)=>x.symbol==='ABCUSDT');
  assert.equal(btc.venues.kucoin,true);
  assert.equal(btc.feePctByExchange.kucoin,0.10);
  assert.equal(abc.feePctByExchange.kucoin,0.30);
});

test('rota KuCoin usa taxa específica do par quando fornecida', () => {
  const r = evaluateAcrossExchanges({
    symbol:'ABCUSDT',
    identityConfirmed:true,
    booksByExchange:{
      kucoin:book(99.9,100),
      gate:book(101.0,101.1),
    },
    budgetUsdt:100,
    costs:{
      exchangeFeePct:{kucoin:0.30,gate:0.10},
      reservePct:0.05,
      recompositionUsdt:0.5,
    },
    rules,
    now,
  });
  assert.equal(r.buyExchange,'kucoin');
  assert.equal(r.sellExchange,'gate');
  assert.ok(r.tradingFeesUsdt > 0.39);
});


test('catálogo não sobrescreve taxa padrão com zero quando feePct é null', () => {
  const markets = buildMultiExchangeUniverse({
    bybitSymbols:[
      {symbol:'BTCUSDT',baseCoin:'BTC',quoteCoin:'USDT',status:'Trading'},
    ],
    okxSymbols:[
      {instId:'BTC-USDT',baseCcy:'BTC',quoteCcy:'USDT',state:'live'},
    ],
    gateSymbols:[
      {id:'BTC_USDT',base:'BTC',quote:'USDT',trade_status:'tradable'},
    ],
  });
  const btc = markets.find((x)=>x.symbol==='BTCUSDT');
  assert.deepEqual(btc.feePctByExchange,{});
});

test('custos padrão multiexchange continuam aplicados quando catálogo não informa fee específica', () => {
  const r = evaluateAcrossExchanges({
    symbol:'BTCUSDT',
    identityConfirmed:true,
    booksByExchange:{
      bybit:book(99.9,100),
      okx:book(100.1,100.2),
    },
    budgetUsdt:100,
    costs:{
      exchangeFeePct:{bybit:0.10,okx:0.10},
      reservePct:0.05,
      recompositionUsdt:0.50,
    },
    rules,
    now,
  });
  assert.ok(r.tradingFeesUsdt > 0.19 && r.tradingFeesUsdt < 0.21);
  assert.ok(r.executionNetPnlUsdt < 0);
  assert.equal(r.eligible,false);
});


test('OKX USDT usa taker regular de 0,10% no modelo atual', () => {
  const r = evaluateRoute({
    symbol:'ETHUSDT',
    identityConfirmed:true,
    buyExchange:'bybit',
    sellExchange:'okx',
    buyBook:book(99.9,100),
    sellBook:book(100.5,100.6),
    budgetUsdt:100,
    costs:{
      exchangeFeePct:{bybit:0.10,okx:0.10},
      reservePct:0.05,
      recompositionUsdt:0.50,
    },
    rules,
    now,
  });
  assert.ok(r.tradingFeesUsdt > 0.19 && r.tradingFeesUsdt < 0.21);
});


test('capital selecionado funciona como teto e preserva oportunidade parcialmente executável', () => {
  const maximumRules = { ...rules, budgetMode:'maximum' };
  const limitedBookBuy = book(99.9,100,1);
  const limitedBookSell = book(101.5,101.6,1);

  const r500 = evaluateRoute({
    symbol:'CAPUSDT',
    identityConfirmed:true,
    buyExchange:'binance',
    sellExchange:'bybit',
    buyBook:limitedBookBuy,
    sellBook:limitedBookSell,
    budgetUsdt:500,
    costs,
    rules:maximumRules,
    now,
  });

  assert.equal(r500.eligible,true);
  assert.equal(r500.requestedBudgetUsdt,500);
  assert.equal(r500.executableBudgetUsdt,100);
  assert.equal(r500.budgetUsdt,100);
  assert.equal(r500.liquidityLimited,true);
  assert.equal(r500.executionSharePct,20);

  const r1000 = evaluateRoute({
    symbol:'CAPUSDT',
    identityConfirmed:true,
    buyExchange:'binance',
    sellExchange:'bybit',
    buyBook:limitedBookBuy,
    sellBook:limitedBookSell,
    budgetUsdt:1000,
    costs,
    rules:maximumRules,
    now,
  });

  assert.equal(r1000.eligible,true);
  assert.equal(r1000.executableBudgetUsdt,100);
  assert.equal(r1000.liquidityLimited,true);
  assert.equal(r1000.executionSharePct,10);
});

test('modo exato antigo continua disponível para regressão', () => {
  const exactRules = { ...rules, budgetMode:'exact' };
  const r = evaluateRoute({
    symbol:'CAPUSDT',
    identityConfirmed:true,
    buyExchange:'binance',
    sellExchange:'bybit',
    buyBook:book(99.9,100,1),
    sellBook:book(101.5,101.6,1),
    budgetUsdt:500,
    costs,
    rules:exactRules,
    now,
  });
  assert.equal(r.eligible,false);
  assert.equal(r.reason,'insufficient_buy_liquidity');
});


test('registro DEX usa chainId + contrato + CEX symbol, nunca ticker isolado', () => {
  assert.equal(validateRegistry(),true);
  const ethLink=DEX_ASSET_REGISTRY.find((x)=>x.cexSymbol==='LINKUSDT' && x.chain==='ethereum');
  const arbLink=DEX_ASSET_REGISTRY.find((x)=>x.cexSymbol==='LINKUSDT' && x.chain==='arbitrum');
  assert.ok(ethLink);
  assert.ok(arbLink);
  assert.notEqual(exactIdentityKey(ethLink),exactIdentityKey(arbLink));
  assert.match(exactIdentityKey(ethLink),/^1:0x[0-9a-f]{40}:LINKUSDT$/);
  assert.match(exactIdentityKey(arbLink),/^42161:0x[0-9a-f]{40}:LINKUSDT$/);
});

test('registro DEX contém apenas contratos EVM explícitos e sem duplicata de identidade', () => {
  const keys=DEX_ASSET_REGISTRY.map(exactIdentityKey);
  assert.equal(new Set(keys).size,keys.length);
  for (const asset of DEX_ASSET_REGISTRY) {
    assert.match(asset.address,/^0x[0-9a-fA-F]{40}$/);
    assert.ok(asset.cexSymbol.endsWith('USDT'));
  }
});


test('formatador de símbolos de depth respeita convenção de cada CEX', () => {
  assert.equal(cexSymbolFormat('binance','BTCUSDT'),'BTCUSDT');
  assert.equal(cexSymbolFormat('bybit','BTCUSDT'),'BTCUSDT');
  assert.equal(cexSymbolFormat('okx','BTCUSDT'),'BTC-USDT');
  assert.equal(cexSymbolFormat('kucoin','BTCUSDT'),'BTC-USDT');
  assert.equal(cexSymbolFormat('gate','BTCUSDT'),'BTC_USDT');
});

test('capacidade de depth soma múltiplos níveis em base e quote', () => {
  const cap=depthCapacity({
    bids:[[100,1],[99,2]],
    asks:[[101,1.5],[102,2]],
  });
  assert.equal(cap.bidBase,3);
  assert.equal(cap.bidQuote,298);
  assert.equal(cap.askBase,3.5);
  assert.equal(cap.askQuote,355.5);
});

test('status de rebalance exige contrato exato para rede verificada', () => {
  assert.equal(transferStatusForRoute({
    publicVerificationAvailable:true,
    networkMatched:true,
    contractVerified:true,
    depositEnabled:true,
    withdrawEnabled:true,
  }),'verified_open');
  assert.equal(transferStatusForRoute({
    publicVerificationAvailable:true,
    networkMatched:true,
    contractVerified:true,
    depositEnabled:false,
    withdrawEnabled:true,
  }),'restricted');
  assert.equal(transferStatusForRoute({
    publicVerificationAvailable:true,
    networkMatched:true,
    contractVerified:false,
    depositEnabled:true,
    withdrawEnabled:true,
  }),'restricted');
  assert.equal(transferStatusForRoute({
    publicVerificationAvailable:true,
    networkMatched:true,
    contractVerified:null,
    depositEnabled:true,
    withdrawEnabled:true,
  }),'unverified');
  assert.equal(transferStatusForRoute({
    publicVerificationAvailable:false,
    depositEnabled:null,
    withdrawEnabled:null,
  }),'unverified');
});


test('DEX curada pode usar fallback de tool key sem relaxar identidade', () => {
  const asset=DEX_ASSET_REGISTRY.find((x)=>x.cexSymbol==='LINKUSDT' && x.chain==='arbitrum');
  assert.ok(asset);
  assert.match(exactIdentityKey(asset),/^42161:0x[0-9a-f]{40}:LINKUSDT$/);
});

test('validação pública de rede mantém exchanges sem endpoint público como não verificadas', async () => {
  const asset=DEX_ASSET_REGISTRY.find((x)=>x.cexSymbol==='LINKUSDT' && x.chain==='arbitrum');
  const result=await (await import('../src/cex-network.js')).validateCexNetwork('okx',asset);
  assert.equal(result.publicVerificationAvailable,false);
  assert.equal(result.status,'not_verifiable_without_authenticated_exchange_api');
});


test('busca de capacidade DEX sempre desce até o mínimo operacional de 10 USDT', () => {
  assert.deepEqual(capacitySearchBudgets(500),[500,250,125,50,10]);
  assert.deepEqual(capacitySearchBudgets(1000),[1000,500,250,100,10]);
  assert.deepEqual(capacitySearchBudgets(25),[25,12.5,10]);
  assert.deepEqual(capacitySearchBudgets(9),[]);
});


test('validação direcional ignora permissão que não é necessária à perna do rebalanceamento', () => {
  const tokenNetwork={
    publicVerificationAvailable:true,
    networkMatched:true,
    contractVerified:true,
    depositEnabled:true,
    withdrawEnabled:false,
  };
  const quoteNetwork={
    publicVerificationAvailable:true,
    networkMatched:true,
    contractVerified:true,
    depositEnabled:false,
    withdrawEnabled:true,
  };

  const dexToCex=rebalanceStatusForRoute({
    direction:'dex_to_cex',
    tokenNetwork,
    quoteNetwork,
  });

  assert.equal(transferActionStatus(tokenNetwork,'deposit'),'verified_open');
  assert.equal(transferActionStatus(tokenNetwork,'withdraw'),'restricted');
  assert.equal(dexToCex.status,'verified_open');
  assert.equal(dexToCex.verifiedRequirements,2);
  assert.deepEqual(
    dexToCex.requirements.map((x)=>[x.key,x.action,x.status]),
    [
      ['token_to_cex','deposit','verified_open'],
      ['usdt_to_chain','withdraw','verified_open'],
    ],
  );
});

test('rebalance CEX para DEX exige saque do token e depósito de USDT', () => {
  const tokenNetwork={
    publicVerificationAvailable:true,
    networkMatched:true,
    contractVerified:true,
    depositEnabled:false,
    withdrawEnabled:true,
  };
  const quoteNetwork={
    publicVerificationAvailable:true,
    networkMatched:true,
    contractVerified:true,
    depositEnabled:true,
    withdrawEnabled:false,
  };

  const cexToDex=rebalanceStatusForRoute({
    direction:'cex_to_dex',
    tokenNetwork,
    quoteNetwork,
  });

  assert.equal(cexToDex.status,'verified_open');
  assert.equal(cexToDex.verifiedRequirements,2);
  assert.deepEqual(
    cexToDex.requirements.map((x)=>[x.key,x.action,x.status]),
    [
      ['token_to_chain','withdraw','verified_open'],
      ['usdt_to_cex','deposit','verified_open'],
    ],
  );
});

test('restrição conhecida na perna de USDT bloqueia o rebalanceamento', () => {
  const tokenNetwork={
    publicVerificationAvailable:true,
    networkMatched:true,
    contractVerified:true,
    depositEnabled:true,
    withdrawEnabled:true,
  };
  const quoteNetwork={
    publicVerificationAvailable:true,
    networkMatched:true,
    contractVerified:true,
    depositEnabled:true,
    withdrawEnabled:false,
  };

  const result=rebalanceStatusForRoute({
    direction:'dex_to_cex',
    tokenNetwork,
    quoteNetwork,
  });

  assert.equal(result.status,'restricted');
  assert.equal(result.requirements.find((x)=>x.key==='usdt_to_chain')?.status,'restricted');
});


test('expansão automática exige contrato exato em duas fontes e rejeita ambiguidade', () => {
  const allowlist=[{canonicalId:'compound',symbol:'COMP',cexSymbol:'COMPUSDT',chain:'ethereum'}];
  const token={chainId:1,symbol:'COMP',name:'Compound',address:'0xc00e94Cb662C3520282E6f5717214004A7f26888',decimals:18};

  const accepted=buildAutoAssetRegistry({
    uniswapTokens:[token],
    lifiTokens:[{...token,address:token.address.toLowerCase()}],
    allowlist,
  });
  assert.equal(accepted.length,1);
  assert.equal(accepted[0].cexSymbol,'COMPUSDT');
  assert.equal(accepted[0].identitySource,'uniswap_token_list+lifi_exact_contract_agreement');

  const mismatch=buildAutoAssetRegistry({
    uniswapTokens:[token],
    lifiTokens:[{...token,address:'0x0000000000000000000000000000000000000001'}],
    allowlist,
  });
  assert.equal(mismatch.length,0);

  const ambiguous=buildAutoAssetRegistry({
    uniswapTokens:[token,{...token,address:'0x0000000000000000000000000000000000000002'}],
    lifiTokens:[token],
    allowlist,
  });
  assert.equal(ambiguous.length,0);
});

test('merge de registros preserva identidade manual e não duplica contrato', () => {
  const manual=DEX_ASSET_REGISTRY[0];
  const merged=mergeAssetRegistries([manual],[{...manual,identitySource:'auto'}]);
  assert.equal(merged.length,1);
  assert.equal(merged[0].identitySource,'manual_exact_contract');
  assert.ok(AUTO_ASSET_ALLOWLIST.length>=30);
});

test('adapters diretos são restritos a protocolos e redes explicitamente suportados', () => {
  assert.equal(directDexAdapterFor('uniswap','ethereum'),'uniswap_v3_quoter');
  assert.equal(directDexAdapterFor('uniswap-v3','arbitrum'),'uniswap_v3_quoter');
  assert.equal(directDexAdapterFor('sushiswap','ethereum'),'sushiswap_v2_router');
  assert.equal(directDexAdapterFor('camelot','arbitrum'),'camelot_v2_router');
  assert.equal(directDexAdapterFor('camelot','ethereum'),null);
  assert.equal(directDexAdapterFor('curve','ethereum'),null);
});

test('calldata de quote direto usa seletores canônicos e contratos exatos', () => {
  const usdt='0xdAC17F958D2ee523a2206206994597C13D831ec7';
  const link='0x514910771AF9Ca656af840dff83E8264EcF986CA';
  const uni=encodeUniswapQuoteExactInputSingle({tokenIn:usdt,tokenOut:link,amountIn:100000000n,fee:3000});
  const v2=encodeV2GetAmountsOut({tokenIn:usdt,tokenOut:link,amountIn:100000000n});
  assert.ok(uni.startsWith('0xc6a5026a'));
  assert.ok(v2.startsWith('0xd06ca61f'));
  assert.ok(uni.toLowerCase().includes(usdt.toLowerCase().slice(2)));
  assert.ok(uni.toLowerCase().includes(link.toLowerCase().slice(2)));
});

test('slippage direto é aplicado em inteiro sem arredondar para cima', () => {
  assert.equal(applyDirectSlippage(1_000_000n,50),995_000n);
  assert.equal(applyDirectSlippage(1_000_001n,50),995_000n);
});

test('decoder V2 extrai array de amounts do retorno ABI', () => {
  const word=(n)=>BigInt(n).toString(16).padStart(64,'0');
  const encoded='0x'+word(32)+word(2)+word(100)+word(123);
  assert.deepEqual(decodeV2AmountsOut(encoded),[100n,123n]);
});


test('pool preliminar exige quote token confiável e contrato base exato', () => {
  const linkArb=DEX_ASSET_REGISTRY.find((x)=>x.symbol==='LINK' && x.chain==='arbitrum');
  assert.ok(linkArb);

  const wethPair={
    quoteToken:{address:'0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'},
  };
  const junkPair={
    quoteToken:{address:'0x0000000000000000000000000000000000000042'},
  };

  assert.equal(poolReferenceIsTrusted(wethPair,linkArb),true);
  assert.equal(poolReferenceIsTrusted(junkPair,linkArb),false);
});

test('matching de rede CEX não aceita substring acidental de ETH', () => {
  const ethAsset=DEX_ASSET_REGISTRY.find((x)=>x.symbol==='LINK' && x.chain==='ethereum');
  const arbAsset=DEX_ASSET_REGISTRY.find((x)=>x.symbol==='LINK' && x.chain==='arbitrum');
  assert.ok(ethAsset);
  assert.ok(arbAsset);

  assert.equal(chainEntryMatches({chainId:'eth',chainName:'ERC20'},ethAsset),true);
  assert.equal(chainEntryMatches({chainId:'ethereum',chainName:'Ethereum'},ethAsset),true);
  assert.equal(chainEntryMatches({chainId:'statemint',chainName:'Asset Hub (Polkadot)'},ethAsset),false);
  assert.equal(chainEntryMatches({chainId:'arbitrum',chainName:'Arbitrum One'},arbAsset),true);
  assert.equal(chainEntryMatches({chainId:'arb',chainName:'Arbitrum'},arbAsset),true);
});


test('CP23 registra novas redes com quote e identidade explícitos', () => {
  for (const chain of ['base','polygon','bsc']) {
    const spec=DEX_CHAINS[chain];
    assert.ok(spec);
    assert.ok(Number.isInteger(spec.chainId));
    assert.match(spec.quoteAddress,/^0x[0-9a-fA-F]{40}$/);
  }
  assert.ok(AUTO_ASSET_ALLOWLIST.some((x)=>x.chain==='base'));
  assert.ok(AUTO_ASSET_ALLOWLIST.some((x)=>x.chain==='polygon'));
  assert.ok(AUTO_ASSET_ALLOWLIST.some((x)=>x.chain==='bsc'));
});

test('CP23 adapters diretos só habilitam redes com contrato conhecido', () => {
  assert.equal(directDexAdapterFor('uniswap-v3','base'),'uniswap_v3_quoter');
  assert.equal(directDexAdapterFor('uniswap-v3','polygon'),'uniswap_v3_quoter');
  assert.equal(directDexAdapterFor('uniswap-v3','bsc'),null);
});

test('CP23 aliases CEX das novas redes permanecem exatos', () => {
  const make=(chain)=>({chain,address:'0x0000000000000000000000000000000000000001',cexSymbol:'TESTUSDT'});
  assert.equal(chainEntryMatches({chain:'BASE'},make('base')),true);
  assert.equal(chainEntryMatches({chain:'MATIC'},make('polygon')),true);
  assert.equal(chainEntryMatches({chain:'BEP20'},make('bsc')),true);
  assert.equal(chainEntryMatches({chain:'basecamp'},make('base')),false);
});
