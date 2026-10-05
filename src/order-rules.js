import {
  consumeBase,
  exchangeFeePct,
  finitePositive,
  normalizeBook,
  quoteCostForBase,
} from './core.js';

function cleanNumber(value) {
  const n=Number(value);
  return Number.isFinite(n) && n>0 ? n : null;
}

function cleanLimit(value) {
  const n=Number(value);
  return Number.isFinite(n) && n>0 ? n : null;
}

function normalizeDecimalString(value) {
  if (value===null || value===undefined || value==='') return null;
  let s=String(value).trim().toLowerCase();
  if (!s) return null;
  if (s.includes('e')) {
    const n=Number(s);
    if (!Number.isFinite(n) || n<=0) return null;
    s=n.toFixed(18);
  }
  if (!/^\d+(?:\.\d+)?$/.test(s)) return null;
  s=s.replace(/^0+(?=\d)/,'');
  if (s.includes('.')) s=s.replace(/0+$/,'').replace(/\.$/,'');
  if (!s || Number(s)<=0) return null;
  return s;
}

function precisionStep(value) {
  const p=Number(value);
  if (!Number.isInteger(p) || p<0 || p>18) return null;
  if (p===0) return '1';
  return `0.${'0'.repeat(p-1)}1`;
}

function maxPositive(...values) {
  const nums=values.map(cleanNumber).filter(Boolean);
  return nums.length ? Math.max(...nums) : null;
}

function pick(...values) {
  return values.find((value)=>value!==null && value!==undefined && value!=='');
}

function binanceRules(item) {
  if (!item || item.status!=='TRADING' || item.quoteAsset!=='USDT') return null;
  const filters=Array.isArray(item.filters)?item.filters:[];
  const find=(type)=>filters.find((x)=>x?.filterType===type)||null;
  const price=find('PRICE_FILTER');
  const lot=find('LOT_SIZE');
  const notional=find('NOTIONAL');
  const minNotional=find('MIN_NOTIONAL');
  const minNotionalValue=pick(notional?.minNotional,minNotional?.minNotional);
  return {
    exchange:'binance',
    symbol:item.symbol,
    source:'exchangeInfo',
    minQty:cleanNumber(lot?.minQty),
    maxQty:cleanLimit(lot?.maxQty),
    qtyStep:normalizeDecimalString(lot?.stepSize),
    minNotional:cleanNumber(minNotionalValue),
    maxNotional:cleanLimit(notional?.maxNotional),
    tickSize:normalizeDecimalString(price?.tickSize),
    minPrice:cleanNumber(price?.minPrice),
    maxPrice:cleanLimit(price?.maxPrice),
    complete:Boolean(normalizeDecimalString(lot?.stepSize)&&normalizeDecimalString(price?.tickSize)&&cleanNumber(lot?.minQty)&&cleanNumber(minNotionalValue)),
  };
}

function bybitRules(item) {
  if (!item || item.status!=='Trading' || item.quoteCoin!=='USDT') return null;
  const lot=item.lotSizeFilter||{};
  const price=item.priceFilter||{};
  return {
    exchange:'bybit',
    symbol:item.symbol,
    source:'v5_instruments_info',
    minQty:cleanNumber(lot.minOrderQty),
    maxQty:cleanLimit(pick(lot.maxLimitOrderQty,lot.maxOrderQty)),
    qtyStep:normalizeDecimalString(pick(lot.basePrecision,lot.qtyStep)),
    minNotional:cleanNumber(pick(lot.minOrderAmt,lot.minNotionalValue)),
    maxNotional:cleanLimit(lot.maxOrderAmt),
    tickSize:normalizeDecimalString(price.tickSize),
    minPrice:cleanNumber(price.minPrice),
    maxPrice:cleanLimit(price.maxPrice),
    complete:Boolean(
      normalizeDecimalString(pick(lot.basePrecision,lot.qtyStep))
      && normalizeDecimalString(price.tickSize)
      && cleanNumber(pick(lot.minOrderAmt,lot.minNotionalValue))
    ),
  };
}

function okxRules(item) {
  if (!item || item.state!=='live' || item.quoteCcy!=='USDT') return null;
  return {
    exchange:'okx',
    symbol:String(item.instId||'').replace('-',''),
    source:'public_instruments',
    minQty:cleanNumber(item.minSz),
    maxQty:cleanLimit(pick(item.maxLmtSz,item.maxMktSz)),
    qtyStep:normalizeDecimalString(item.lotSz),
    minNotional:null,
    maxNotional:null,
    tickSize:normalizeDecimalString(item.tickSz),
    minPrice:null,
    maxPrice:null,
    complete:Boolean(cleanNumber(item.minSz)&&normalizeDecimalString(item.lotSz)&&normalizeDecimalString(item.tickSz)),
  };
}

function gateRules(item) {
  if (!item || item.trade_status!=='tradable' || item.quote!=='USDT') return null;
  return {
    exchange:'gate',
    symbol:`${String(item.base||'').toUpperCase()}USDT`,
    source:'spot_currency_pairs',
    minQty:cleanNumber(item.min_base_amount),
    maxQty:cleanLimit(item.max_base_amount),
    qtyStep:precisionStep(item.amount_precision),
    minNotional:cleanNumber(item.min_quote_amount),
    maxNotional:cleanLimit(item.max_quote_amount),
    tickSize:precisionStep(item.precision),
    minPrice:null,
    maxPrice:null,
    complete:Boolean(
      cleanNumber(item.min_base_amount)
      && cleanNumber(item.min_quote_amount)
      && precisionStep(item.amount_precision)
      && precisionStep(item.precision)
    ),
  };
}

function kucoinRules(item) {
  const enabled=item?.tradingStatus==='TradingEnabled' || item?.enableTrading===true;
  if (!enabled || item?.quoteCurrency!=='USDT') return null;
  const minNotional=maxPositive(item.minQuoteOrderSize,item.quoteMinSize,item.minFunds);
  return {
    exchange:'kucoin',
    symbol:`${String(item.baseCurrency||'').toUpperCase()}USDT`,
    source:'ua_spot_instrument',
    minQty:cleanNumber(pick(item.minBaseOrderSize,item.baseMinSize)),
    maxQty:cleanLimit(pick(item.maxBaseOrderSize,item.baseMaxSize)),
    qtyStep:normalizeDecimalString(pick(item.baseOrderStep,item.baseIncrement)),
    minNotional,
    maxNotional:cleanLimit(pick(item.maxQuoteOrderSize,item.quoteMaxSize)),
    tickSize:normalizeDecimalString(pick(item.tickSize,item.priceIncrement)),
    minPrice:null,
    maxPrice:null,
    complete:Boolean(
      cleanNumber(pick(item.minBaseOrderSize,item.baseMinSize))
      && normalizeDecimalString(pick(item.baseOrderStep,item.baseIncrement))
      && normalizeDecimalString(pick(item.tickSize,item.priceIncrement))
      && minNotional
    ),
  };
}

function bitgetRules(item) {
  const online=String(item?.status||'').toLowerCase()==='online';
  if (!online || item?.quoteCoin!=='USDT') return null;
  const crypto=!item?.symbolType || String(item.symbolType).toLowerCase()==='crypto';
  const rwa=String(item?.isRwa||'NO').toUpperCase()==='YES'
    || String(item?.isReality||'no').toLowerCase()==='yes';
  if (!crypto || rwa) return null;
  return {
    exchange:'bitget',
    symbol:item.symbol,
    source:'v3_market_instruments',
    minQty:cleanNumber(item.minOrderQty),
    maxQty:cleanLimit(item.maxOrderQty),
    qtyStep:precisionStep(item.quantityPrecision),
    minNotional:cleanNumber(item.minOrderAmount),
    maxNotional:null,
    tickSize:precisionStep(item.pricePrecision),
    minPrice:null,
    maxPrice:null,
    complete:Boolean(
      cleanNumber(item.minOrderQty)
      && cleanNumber(item.minOrderAmount)
      && precisionStep(item.quantityPrecision)
      && precisionStep(item.pricePrecision)
    ),
  };
}

function htxRules(item) {
  const state=String(pick(item?.state,item?.te===true?'online':null)||'').toLowerCase();
  if (state && state!=='online') return null;
  const base=pick(item?.bc,item?.['base-currency'],item?.baseCurrency);
  const quote=String(pick(item?.qc,item?.['quote-currency'],item?.quoteCurrency)||'').toUpperCase();
  if (!base || quote!=='USDT') return null;
  const amountPrecision=pick(item?.ap,item?.['amount-precision']);
  const pricePrecision=pick(item?.pp,item?.['price-precision']);
  const minQty=pick(
    item?.lominoa,
    item?.['limit-order-min-order-amt'],
    item?.minoa,
    item?.['min-order-amt'],
  );
  const maxQty=pick(
    item?.lomaxoa,
    item?.['limit-order-max-order-amt'],
    item?.maxoa,
    item?.['max-order-amt'],
  );
  const minNotional=pick(item?.minov,item?.['min-order-value']);
  const maxNotional=pick(item?.maxov,item?.['max-order-value']);
  return {
    exchange:'htx',
    symbol:`${String(base).toUpperCase()}USDT`,
    source:'market_symbols',
    minQty:cleanNumber(minQty),
    maxQty:cleanLimit(maxQty),
    qtyStep:precisionStep(amountPrecision),
    minNotional:cleanNumber(minNotional),
    maxNotional:cleanLimit(maxNotional),
    tickSize:precisionStep(pricePrecision),
    minPrice:null,
    maxPrice:null,
    complete:Boolean(
      cleanNumber(minQty)
      && cleanNumber(minNotional)
      && precisionStep(amountPrecision)
      && precisionStep(pricePrecision)
    ),
  };
}

export function normalizeOrderRule(exchange,item) {
  if (exchange==='binance') return binanceRules(item);
  if (exchange==='bybit') return bybitRules(item);
  if (exchange==='okx') return okxRules(item);
  if (exchange==='gate') return gateRules(item);
  if (exchange==='kucoin') return kucoinRules(item);
  if (exchange==='bitget') return bitgetRules(item);
  if (exchange==='htx') return htxRules(item);
  return null;
}

export function buildOrderRulesIndex({
  binanceSymbols=[],
  bybitSymbols=[],
  okxSymbols=[],
  gateSymbols=[],
  kucoinSymbols=[],
  bitgetSymbols=[],
  htxSymbols=[],
}={}) {
  const bySymbol=new Map();
  const coverage={binance:0,bybit:0,okx:0,gate:0,kucoin:0,bitget:0,htx:0};

  const add=(exchange,items)=>{
    for (const item of items||[]) {
      const rule=normalizeOrderRule(exchange,item);
      if (!rule?.symbol) continue;
      const symbol=String(rule.symbol).toUpperCase();
      if (!bySymbol.has(symbol)) bySymbol.set(symbol,{});
      bySymbol.get(symbol)[exchange]=rule;
      if (rule.complete) coverage[exchange]+=1;
    }
  };

  add('binance',binanceSymbols);
  add('bybit',bybitSymbols);
  add('okx',okxSymbols);
  add('gate',gateSymbols);
  add('kucoin',kucoinSymbols);
  add('bitget',bitgetSymbols);
  add('htx',htxSymbols);

  return {bySymbol,coverage};
}

function decimalParts(value) {
  const s=normalizeDecimalString(value);
  if (!s) return null;
  const [whole,frac='']=s.split('.');
  const digits=`${whole}${frac}`.replace(/^0+(?=\d)/,'')||'0';
  return {int:BigInt(digits),scale:frac.length};
}

function gcd(a,b) {
  let x=a<0n?-a:a;
  let y=b<0n?-b:b;
  while (y) [x,y]=[y,x%y];
  return x;
}

function lcm(a,b) {
  if (!a || !b) return 0n;
  return (a/gcd(a,b))*b;
}

export function commonQuantityStep(a,b) {
  const A=decimalParts(a);
  const B=decimalParts(b);
  if (!A || !B) return null;
  const scale=Math.max(A.scale,B.scale);
  const ai=A.int*(10n**BigInt(scale-A.scale));
  const bi=B.int*(10n**BigInt(scale-B.scale));
  const li=lcm(ai,bi);
  if (!li) return null;
  const n=Number(li)/10**scale;
  return Number.isFinite(n)&&n>0?n:null;
}

function floorToStep(value,step) {
  const n=Number(value);
  const s=Number(step);
  if (!(n>0) || !(s>0)) return null;
  const units=Math.floor((n/s)+1e-10);
  const out=units*s;
  return out>0?out:null;
}

function ceilToStep(value,step) {
  const n=Number(value);
  const s=Number(step);
  if (!(n>0) || !(s>0)) return null;
  return Math.ceil((n/s)-1e-10)*s;
}

function priceForQty(levels,qty,side) {
  let left=Number(qty);
  if (!(left>0) || !Array.isArray(levels)) return null;
  let worst=null;
  for (const [price,size] of levels) {
    const take=Math.min(left,Number(size));
    if (!(take>0)) continue;
    worst=Number(price);
    left-=take;
    if (left<=1e-12) break;
  }
  if (left>1e-9 || !(worst>0)) return null;
  return side==='buy'?worst:worst;
}

function within(value,min,max) {
  const n=Number(value);
  if (!Number.isFinite(n)) return false;
  if (Number.isFinite(Number(min)) && Number(min)>0 && n+1e-12<Number(min)) return false;
  if (Number.isFinite(Number(max)) && Number(max)>0 && n-1e-12>Number(max)) return false;
  return true;
}

function reason(label,details={}) {
  return {operationalOk:false,orderRulesVerified:false,reason:label,...details};
}

export function validateOperationalRoute({
  route,
  buyBook,
  sellBook,
  buyRules,
  sellRules,
  costs,
}={}) {
  if (!route?.eligible || !(Number(route?.baseQty)>0)) {
    return reason('route_not_depth_eligible');
  }
  if (!buyRules?.complete || !sellRules?.complete) {
    return reason('instrument_rules_unverified',{
      buyRulesKnown:Boolean(buyRules?.complete),
      sellRulesKnown:Boolean(sellRules?.complete),
    });
  }

  const buy=normalizeBook(buyBook);
  const sell=normalizeBook(sellBook);
  if (!buy || !sell) return reason('depth_unavailable_for_operational_check');

  const commonStep=commonQuantityStep(buyRules.qtyStep,sellRules.qtyStep);
  if (!(commonStep>0)) return reason('quantity_step_unverified');

  const baseQty=floorToStep(route.baseQty,commonStep);
  if (!(baseQty>0)) return {
    operationalOk:false,
    orderRulesVerified:true,
    reason:'quantity_rounds_to_zero',
    commonQtyStep:commonStep,
  };

  if (!within(baseQty,buyRules.minQty,buyRules.maxQty)) {
    return {
      operationalOk:false,
      orderRulesVerified:true,
      reason:'buy_quantity_rule_failed',
      baseQty,
      commonQtyStep:commonStep,
      minQty:buyRules.minQty,
      maxQty:buyRules.maxQty,
    };
  }
  if (!within(baseQty,sellRules.minQty,sellRules.maxQty)) {
    return {
      operationalOk:false,
      orderRulesVerified:true,
      reason:'sell_quantity_rule_failed',
      baseQty,
      commonQtyStep:commonStep,
      minQty:sellRules.minQty,
      maxQty:sellRules.maxQty,
    };
  }

  const buyCost=quoteCostForBase(buy.asks,baseQty);
  const sellProceeds=consumeBase(sell.bids,baseQty);
  if (!buyCost?.filled || !sellProceeds?.filled) {
    return {
      operationalOk:false,
      orderRulesVerified:true,
      reason:'depth_insufficient_after_rounding',
      baseQty,
      commonQtyStep:commonStep,
    };
  }

  if (buyRules.minNotional && buyCost.quoteSpent+1e-9<buyRules.minNotional) {
    return {
      operationalOk:false,
      orderRulesVerified:true,
      reason:'buy_min_notional_failed',
      baseQty,
      notionalUsdt:buyCost.quoteSpent,
      minNotional:buyRules.minNotional,
    };
  }
  if (sellRules.minNotional && sellProceeds.quoteReceived+1e-9<sellRules.minNotional) {
    return {
      operationalOk:false,
      orderRulesVerified:true,
      reason:'sell_min_notional_failed',
      baseQty,
      notionalUsdt:sellProceeds.quoteReceived,
      minNotional:sellRules.minNotional,
    };
  }
  if (buyRules.maxNotional && buyCost.quoteSpent-1e-9>buyRules.maxNotional) {
    return {
      operationalOk:false,
      orderRulesVerified:true,
      reason:'buy_max_notional_failed',
      baseQty,
      notionalUsdt:buyCost.quoteSpent,
      maxNotional:buyRules.maxNotional,
    };
  }
  if (sellRules.maxNotional && sellProceeds.quoteReceived-1e-9>sellRules.maxNotional) {
    return {
      operationalOk:false,
      orderRulesVerified:true,
      reason:'sell_max_notional_failed',
      baseQty,
      notionalUsdt:sellProceeds.quoteReceived,
      maxNotional:sellRules.maxNotional,
    };
  }

  const worstBuy=priceForQty(buy.asks,baseQty,'buy');
  const worstSell=priceForQty(sell.bids,baseQty,'sell');
  const buyLimitPrice=ceilToStep(worstBuy,Number(buyRules.tickSize));
  const sellLimitPrice=floorToStep(worstSell,Number(sellRules.tickSize));
  if (!(buyLimitPrice>0) || !(sellLimitPrice>0)) {
    return {
      operationalOk:false,
      orderRulesVerified:true,
      reason:'price_tick_unverified',
      baseQty,
    };
  }
  if (!within(buyLimitPrice,buyRules.minPrice,buyRules.maxPrice)) {
    return {
      operationalOk:false,
      orderRulesVerified:true,
      reason:'buy_price_rule_failed',
      baseQty,
      buyLimitPrice,
    };
  }
  if (!within(sellLimitPrice,sellRules.minPrice,sellRules.maxPrice)) {
    return {
      operationalOk:false,
      orderRulesVerified:true,
      reason:'sell_price_rule_failed',
      baseQty,
      sellLimitPrice,
    };
  }

  const buyFeeRate=(exchangeFeePct(route.buyExchange,costs)||0)/100;
  const sellFeeRate=(exchangeFeePct(route.sellExchange,costs)||0)/100;
  const reserveRate=(Number(costs?.reservePct)||0)/100;
  const grossPnl=sellProceeds.quoteReceived-buyCost.quoteSpent;
  const tradingFees=(buyCost.quoteSpent*buyFeeRate)+(sellProceeds.quoteReceived*sellFeeRate);
  const reserve=(buyCost.quoteSpent+sellProceeds.quoteReceived)*reserveRate;
  const netPnl=grossPnl-tradingFees-reserve;
  if (!(netPnl>0)) {
    return {
      operationalOk:false,
      orderRulesVerified:true,
      reason:'non_positive_after_order_rounding',
      baseQty,
      buyLimitPrice,
      sellLimitPrice,
      operationalNetPnlUsdt:netPnl,
    };
  }

  const recomposition=Math.max(0,Number(costs?.recompositionUsdt)||0);
  const executionSharePct=Number(route?.requestedBudgetUsdt)>0
    ? (buyCost.quoteSpent/Number(route.requestedBudgetUsdt))*100
    : route?.executionSharePct;

  return {
    operationalOk:true,
    orderRulesVerified:true,
    reason:'operational_ok',
    executionOrderModel:'marketable_limit_parameters',
    baseQty,
    commonQtyStep:commonStep,
    buyLimitPrice,
    sellLimitPrice,
    buyNotionalUsdt:buyCost.quoteSpent,
    sellNotionalUsdt:sellProceeds.quoteReceived,
    operationalNetPnlUsdt:netPnl,
    buyRules:{
      minQty:buyRules.minQty,
      maxQty:buyRules.maxQty,
      qtyStep:buyRules.qtyStep,
      minNotional:buyRules.minNotional,
      maxNotional:buyRules.maxNotional,
      tickSize:buyRules.tickSize,
      source:buyRules.source,
    },
    sellRules:{
      minQty:sellRules.minQty,
      maxQty:sellRules.maxQty,
      qtyStep:sellRules.qtyStep,
      minNotional:sellRules.minNotional,
      maxNotional:sellRules.maxNotional,
      tickSize:sellRules.tickSize,
      source:sellRules.source,
    },
    result:{
      ...route,
      baseQty,
      budgetUsdt:buyCost.quoteSpent,
      executableBudgetUsdt:buyCost.quoteSpent,
      executionSharePct,
      buyVwap:buyCost.vwap,
      sellVwap:sellProceeds.vwap,
      grossPnlUsdt:grossPnl,
      grossSpreadPct:(grossPnl/buyCost.quoteSpent)*100,
      buyTradingFeeUsdt:buyCost.quoteSpent*buyFeeRate,
      sellTradingFeeUsdt:sellProceeds.quoteReceived*sellFeeRate,
      tradingFeesUsdt:tradingFees,
      reserveUsdt:reserve,
      executionNetPnlUsdt:netPnl,
      netPnlUsdt:netPnl,
      netAfterRebalanceUsdt:netPnl-recomposition,
      netPctOnBuy:(netPnl/buyCost.quoteSpent)*100,
      roiOnTotalCapitalPct:(netPnl/(buyCost.quoteSpent*2))*100,
      orderRulesVerified:true,
      operationalOk:true,
      executionOrderModel:'marketable_limit_parameters',
      buyLimitPrice,
      sellLimitPrice,
      commonQtyStep:commonStep,
    },
  };
}
