import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOrderRulesIndex,
  commonQuantityStep,
  normalizeOrderRule,
  validateOperationalRoute,
} from '../src/order-rules.js';

test('normaliza regras públicas essenciais das 7 CEXs', () => {
  const fixtures={
    binance:{
      status:'TRADING',symbol:'BTCUSDT',quoteAsset:'USDT',
      filters:[
        {filterType:'PRICE_FILTER',minPrice:'0.01',maxPrice:'1000000',tickSize:'0.01'},
        {filterType:'LOT_SIZE',minQty:'0.00001',maxQty:'1000',stepSize:'0.00001'},
        {filterType:'MIN_NOTIONAL',minNotional:'5'},
      ],
    },
    bybit:{
      status:'Trading',symbol:'BTCUSDT',quoteCoin:'USDT',
      priceFilter:{tickSize:'0.01'},
      lotSizeFilter:{basePrecision:'0.000001',minOrderAmt:'5',maxLimitOrderQty:'1000'},
    },
    okx:{
      state:'live',instId:'BTC-USDT',quoteCcy:'USDT',
      minSz:'0.00001',lotSz:'0.00000001',tickSz:'0.1',maxLmtSz:'1000',
    },
    gate:{
      trade_status:'tradable',base:'BTC',quote:'USDT',
      min_base_amount:'0.00001',max_base_amount:'1000',min_quote_amount:'1',
      amount_precision:8,precision:1,
    },
    kucoin:{
      tradingStatus:'TradingEnabled',baseCurrency:'BTC',quoteCurrency:'USDT',
      minBaseOrderSize:'0.0001',maxBaseOrderSize:'1000',baseOrderStep:'0.000001',
      minQuoteOrderSize:'0.1',minFunds:'1',tickSize:'0.1',
    },
    bitget:{
      status:'online',symbol:'BTCUSDT',quoteCoin:'USDT',symbolType:'crypto',isRwa:'NO',isReality:'no',
      minOrderQty:'0.000001',maxOrderQty:'0',quantityPrecision:'6',pricePrecision:'2',minOrderAmount:'1',
    },
    htx:{
      state:'online','base-currency':'btc','quote-currency':'usdt',
      'amount-precision':6,'price-precision':2,
      'limit-order-min-order-amt':'0.00001','min-order-value':'5',
    },
  };

  for (const [exchange,item] of Object.entries(fixtures)) {
    const rule=normalizeOrderRule(exchange,item);
    assert.ok(rule,exchange);
    assert.equal(rule.symbol,'BTCUSDT',exchange);
    assert.equal(rule.complete,true,exchange);
    assert.ok(Number(rule.qtyStep)>0,exchange);
    assert.ok(Number(rule.tickSize)>0,exchange);
  }
});

test('índice de regras mede cobertura sem transformar regra ausente em aprovada', () => {
  const index=buildOrderRulesIndex({
    bitgetSymbols:[{
      status:'online',symbol:'ABCUSDT',quoteCoin:'USDT',symbolType:'crypto',
      isRwa:'NO',isReality:'no',minOrderQty:'1',quantityPrecision:'0',
      pricePrecision:'4',minOrderAmount:'5',
    }],
    bybitSymbols:[{
      status:'Trading',symbol:'ABCUSDT',quoteCoin:'USDT',
      priceFilter:{tickSize:'0.0001'},
      lotSizeFilter:{basePrecision:'1',minOrderAmt:'5'},
    }],
  });
  assert.equal(index.coverage.bitget,1);
  assert.equal(index.coverage.bybit,1);
  assert.equal(index.coverage.binance,0);
  assert.equal(index.bySymbol.get('ABCUSDT').bitget.complete,true);
});

test('calcula step comum exato para passos decimais incompatíveis', () => {
  assert.equal(commonQuantityStep('0.05','0.02'),0.1);
  assert.equal(commonQuantityStep('0.001','0.0001'),0.001);
  assert.equal(commonQuantityStep('1','0.25'),1);
});

test('Operational Gate recalcula quantidade e lucro após regras de ordem', () => {
  const route={
    eligible:true,
    symbol:'TESTUSDT',
    buyExchange:'bybit',
    sellExchange:'gate',
    baseQty:1.037,
    requestedBudgetUsdt:200,
    executableBudgetUsdt:103.7,
    executionSharePct:51.85,
  };
  const buyBook={
    ts:1000,
    asks:[[100,2],[101,2]],
    bids:[[99,2]],
  };
  const sellBook={
    ts:1000,
    asks:[[103,2]],
    bids:[[102,2],[101.5,2]],
  };
  const buyRules={
    complete:true,minQty:0.01,maxQty:100,qtyStep:'0.01',minNotional:5,maxNotional:null,
    tickSize:'0.01',minPrice:null,maxPrice:null,source:'fixture',
  };
  const sellRules={
    complete:true,minQty:0.001,maxQty:100,qtyStep:'0.001',minNotional:1,maxNotional:null,
    tickSize:'0.01',minPrice:null,maxPrice:null,source:'fixture',
  };
  const out=validateOperationalRoute({
    route,buyBook,sellBook,buyRules,sellRules,
    costs:{exchangeFeePct:{bybit:0,gate:0},reservePct:0,recompositionUsdt:0},
  });

  assert.equal(out.operationalOk,true);
  assert.equal(out.orderRulesVerified,true);
  assert.equal(out.baseQty,1.03);
  assert.equal(out.commonQtyStep,0.01);
  assert.equal(out.buyLimitPrice,100);
  assert.equal(out.sellLimitPrice,102);
  assert.ok(out.operationalNetPnlUsdt>0);
  assert.equal(out.result.operationalOk,true);
});

test('Operational Gate bloqueia depth positivo que não atinge minNotional', () => {
  const out=validateOperationalRoute({
    route:{
      eligible:true,symbol:'TINYUSDT',buyExchange:'bybit',sellExchange:'gate',
      baseQty:0.05,requestedBudgetUsdt:10,executableBudgetUsdt:5,
    },
    buyBook:{ts:1000,asks:[[100,1]],bids:[[99,1]]},
    sellBook:{ts:1000,asks:[[102,1]],bids:[[101,1]]},
    buyRules:{
      complete:true,minQty:0.01,maxQty:100,qtyStep:'0.01',minNotional:10,
      tickSize:'0.01',source:'fixture',
    },
    sellRules:{
      complete:true,minQty:0.01,maxQty:100,qtyStep:'0.01',minNotional:1,
      tickSize:'0.01',source:'fixture',
    },
    costs:{exchangeFeePct:{bybit:0,gate:0},reservePct:0,recompositionUsdt:0},
  });
  assert.equal(out.operationalOk,false);
  assert.equal(out.orderRulesVerified,true);
  assert.equal(out.reason,'buy_min_notional_failed');
});


test('KuCoin também aceita o formato público v2 baseMinSize/baseIncrement/priceIncrement', () => {
  const rule=normalizeOrderRule('kucoin',{
    enableTrading:true,
    baseCurrency:'ABC',
    quoteCurrency:'USDT',
    baseMinSize:'0.1',
    baseMaxSize:'100000',
    baseIncrement:'0.01',
    quoteMinSize:'0.1',
    quoteMaxSize:'1000000',
    priceIncrement:'0.0001',
    minFunds:'1',
  });
  assert.equal(rule.symbol,'ABCUSDT');
  assert.equal(rule.complete,true);
  assert.equal(rule.minQty,0.1);
  assert.equal(rule.qtyStep,'0.01');
  assert.equal(rule.tickSize,'0.0001');
  assert.equal(rule.minNotional,1);
});
