import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOrderBookMessage, evaluateAcrossExchanges, evaluatePair, evaluateRoute, topPositive } from '../src/core.js';
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
  assert.ok(r.tradingFeesUsdt > 0.49);
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
      exchangeFeePct:{binance:0.1,bybit:0.1,okx:0.4,gate:0.1},
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
      okx:book(100.5,100.6),
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
  assert.ok(r.tradingFeesUsdt > 0.49);
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
