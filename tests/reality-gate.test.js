import test from 'node:test';
import assert from 'node:assert/strict';
import { createRealityGate, realityConfidenceScore } from '../src/reality-gate.js';

function profitableBook(exchange, symbol, side, ts) {
  if (side==='buy') {
    return {
      exchange,symbol,ts,source:`mock://${exchange}/${symbol}`,
      asks:[[100,10],[100.2,10]],
      bids:[[99.8,10]],
    };
  }
  return {
    exchange,symbol,ts,source:`mock://${exchange}/${symbol}`,
    asks:[[102.2,10]],
    bids:[[102,10],[101.8,10]],
  };
}

test('Reality Gate só promove após 3 confirmações consecutivas de depth', async () => {
  let clock=10_000;
  const fetchDepth=async(exchange,symbol)=>{
    const side=exchange==='binance'?'buy':'sell';
    return profitableBook(exchange,symbol,side,clock);
  };
  const gate=createRealityGate({
    fetchDepth,
    now:()=>clock,
    config:{requiredStreak:3,minCheckIntervalMs:0,persistenceGapMs:5_000,confirmationTtlMs:6_000},
  });
  const route={symbol:'TESTUSDT',buyExchange:'binance',sellExchange:'bybit',eligible:true,netPnlUsdt:1};
  const context={
    asset:{identityConfirmed:true},
    budgetUsdt:100,
    costs:{exchangeFeePct:{binance:0,bybit:0},reservePct:0,recompositionUsdt:0},
  };

  let s=await gate.check(route,context);
  assert.equal(s.confirmed,false);
  assert.equal(s.confirmationStreak,1);

  clock+=1_000;
  s=await gate.check(route,context);
  assert.equal(s.confirmed,false);
  assert.equal(s.confirmationStreak,2);

  clock+=1_000;
  s=await gate.check(route,context);
  assert.equal(s.confirmed,true);
  assert.equal(s.confirmationStreak,3);
  assert.equal(s.depthConfirmed,true);
  assert.equal(s.result.eligible,true);

  const confirmed=gate.confirmed([route],100);
  assert.equal(confirmed.length,1);
  assert.equal(confirmed[0].realityStatus,'confirmed');
  assert.equal(confirmed[0].executionMode,'prepositioned_inventory');
  assert.equal(confirmed[0].transferabilityVerified,false);
});

test('Reality Gate derruba confirmação quando depth deixa de ser lucrativo', async () => {
  let clock=20_000;
  let profitable=true;
  const fetchDepth=async(exchange,symbol)=>{
    if (exchange==='binance') return profitableBook(exchange,symbol,'buy',clock);
    if (profitable) return profitableBook(exchange,symbol,'sell',clock);
    return {
      exchange,symbol,ts:clock,source:'mock://bad',
      asks:[[100.2,10]],
      bids:[[99.9,10]],
    };
  };
  const gate=createRealityGate({
    fetchDepth,
    now:()=>clock,
    config:{requiredStreak:1,minCheckIntervalMs:0,confirmationTtlMs:6_000},
  });
  const route={symbol:'TESTUSDT',buyExchange:'binance',sellExchange:'bybit',eligible:true,netPnlUsdt:1};
  const context={
    asset:{identityConfirmed:true},
    budgetUsdt:100,
    costs:{exchangeFeePct:{binance:0,bybit:0},reservePct:0,recompositionUsdt:0},
  };

  let s=await gate.check(route,context);
  assert.equal(s.confirmed,true);
  profitable=false;
  clock+=1_000;
  s=await gate.check(route,context);
  assert.equal(s.confirmed,false);
  assert.equal(s.confirmationStreak,0);
  assert.equal(gate.confirmed([route],100).length,0);
});

test('score de confiança recompensa depth, persistência, sincronismo e capacidade', () => {
  const strong=realityConfidenceScore({
    streak:3,requiredStreak:3,ageMs:200,skewMs:100,executionSharePct:100,depthConfirmed:true,
  });
  const weak=realityConfidenceScore({
    streak:1,requiredStreak:3,ageMs:4_000,skewMs:3_000,executionSharePct:20,depthConfirmed:true,
  });
  assert.ok(strong>weak);
  assert.equal(strong,100);
});


test('OPERACIONAL OK só aparece depois do depth 3/3 e regras públicas válidas', async () => {
  let clock=30_000;
  const fetchDepth=async(exchange,symbol)=>{
    const side=exchange==='binance'?'buy':'sell';
    return profitableBook(exchange,symbol,side,clock);
  };
  const gate=createRealityGate({
    fetchDepth,
    now:()=>clock,
    config:{requiredStreak:3,minCheckIntervalMs:0,persistenceGapMs:5_000,confirmationTtlMs:6_000},
  });
  const route={symbol:'TESTUSDT',buyExchange:'binance',sellExchange:'bybit',eligible:true,netPnlUsdt:1};
  const rule={
    complete:true,minQty:0.01,maxQty:1000,qtyStep:'0.01',minNotional:1,maxNotional:null,
    tickSize:'0.01',minPrice:null,maxPrice:null,source:'fixture',
  };
  const context={
    asset:{identityConfirmed:true},
    budgetUsdt:100,
    costs:{exchangeFeePct:{binance:0,bybit:0},reservePct:0,recompositionUsdt:0},
    orderRulesByExchange:{binance:rule,bybit:rule},
  };

  let s=await gate.check(route,context);
  assert.equal(s.confirmationStreak,1);
  assert.equal(s.orderRulesVerified,true);
  assert.equal(s.operationalOk,false);
  assert.equal(s.operationalReason,'awaiting_persistence');

  clock+=1_000;
  s=await gate.check(route,context);
  assert.equal(s.confirmationStreak,2);
  assert.equal(s.operationalOk,false);

  clock+=1_000;
  s=await gate.check(route,context);
  assert.equal(s.confirmed,true);
  assert.equal(s.operationalOk,true);
  assert.equal(s.operationalReason,'operational_ok');

  const top=gate.confirmed([route],100);
  assert.equal(top.length,1);
  assert.equal(top[0].operationalOk,true);
  assert.equal(top[0].orderRulesVerified,true);
  assert.ok(top[0].operationalPlan?.baseQty>0);
});
