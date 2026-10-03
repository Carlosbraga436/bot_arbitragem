import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOrderBookMessage, evaluatePair, evaluateRoute, topPositive } from '../src/core.js';
import { chunkTopics, createMarketHub, selectConfirmedSymbols } from '../src/market-hub.js';

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

test('custos transformam spread bruto pequeno em resultado não positivo', () => {
  const r = evaluateRoute({ symbol:'BTCUSDT', identityConfirmed:true, buyExchange:'binance', sellExchange:'bybit', buyBook:book(99.8,100), sellBook:book(100.4,100.5), budgetUsdt:100, costs, rules, now });
  assert.ok(r.grossPnlUsdt > 0); assert.ok(r.netPnlUsdt < 0); assert.equal(r.eligible,false);
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


test('Bybit spot divide 15 tópicos em lotes de no máximo 10', () => {
  const topics = Array.from({ length: 15 }, (_, i) => `orderbook.50.S${i}USDT`);
  const chunks = chunkTopics(topics);
  assert.deepEqual(chunks.map((x) => x.length), [10, 5]);
  assert.deepEqual(chunks.flat(), topics);
  assert.ok(chunks.every((x) => x.length <= 10));
});


test('seleção monitorada usa somente identidades confirmadas e preenche até o limite', () => {
  const candidates = [
    { symbol:'BTCUSDT', identityConfirmed:true },
    { symbol:'ETHUSDT', identityConfirmed:true },
    { symbol:'TONUSDT', identityConfirmed:false },
    { symbol:'SHIBUSDT', identityConfirmed:true },
    { symbol:'AAVEUSDT', identityConfirmed:true },
  ];
  const selected = selectConfirmedSymbols(candidates, ['BTCUSDT','ETHUSDT','TONUSDT','SHIBUSDT'], 4);
  assert.deepEqual(selected, ['BTCUSDT','ETHUSDT','SHIBUSDT','AAVEUSDT']);
  assert.ok(!selected.includes('TONUSDT'));
});
