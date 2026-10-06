import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { exchangeTradeUrl, splitUsdtSymbol } from '../public/exchange-links.js';
import { auditRouteKey, selectLockedRoute } from '../public/manual-audit.js';

test('gera links Spot oficiais para as 7 CEXs', () => {
  assert.deepEqual(splitUsdtSymbol('BTCUSDT'),{symbol:'BTCUSDT',base:'BTC',quote:'USDT'});
  assert.equal(exchangeTradeUrl('binance','BTCUSDT'),'https://www.binance.com/en/trade/BTC_USDT');
  assert.equal(exchangeTradeUrl('bybit','BTCUSDT'),'https://www.bybit.com/en/trade/spot/BTC/USDT');
  assert.equal(exchangeTradeUrl('okx','BTCUSDT'),'https://www.okx.com/en-br/trade-spot/btc-usdt');
  assert.equal(exchangeTradeUrl('gate','BTCUSDT'),'https://www.gate.com/trade/BTC_USDT');
  assert.equal(exchangeTradeUrl('kucoin','BTCUSDT'),'https://www.kucoin.com/trade/BTC-USDT');
  assert.equal(exchangeTradeUrl('bitget','BTCUSDT'),'https://www.bitget.com/markets/spot/BTCUSDT');
  assert.equal(exchangeTradeUrl('htx','BTCUSDT'),'https://www.htx.com/trade/btc_usdt/');
  assert.equal(exchangeTradeUrl('binance','BTCBRL'),null);
});

test('route lock usa símbolo + compra + venda e nunca cai silenciosamente em outra moeda', () => {
  const locked={symbol:'OGNUSDT',buyExchange:'htx',sellExchange:'bitget',netPnlUsdt:1.2};
  const another={symbol:'LUNCUSDT',buyExchange:'kucoin',sellExchange:'bybit',netPnlUsdt:2.0};
  const sameSymbolOtherDirection={symbol:'OGNUSDT',buyExchange:'bitget',sellExchange:'htx',netPnlUsdt:1.5};
  const key=auditRouteKey(locked);

  assert.equal(key,'OGNUSDT|htx|bitget');
  assert.equal(selectLockedRoute({top5:[another,locked]},key),locked);
  assert.equal(selectLockedRoute({top5:[another,sameSymbolOtherDirection]},key),null);
  assert.equal(selectLockedRoute({signals:[locked]},key),locked);
});

test('CP30 expõe conferência ao vivo, volta explícita e sincronização travada na rota', async () => {
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const audit=await readFile(new URL('../public/manual-audit.js',import.meta.url),'utf8');

  for(const id of ['manualAudit','manualAuditBody','manualAuditBack','manualAuditRefresh','manualAuditCopy']){
    assert.match(html,new RegExp('id=["\\\']'+id+'["\\\']'));
  }

  assert.match(html,/Voltar ao radar/);
  assert.match(html,/CONFERÊNCIA AO VIVO/);
  assert.match(app,/getRadar:\(\)=>state\.lastRadar/);
  assert.match(app,/manualAudit\.sync\(\)/);
  assert.match(audit,/lockedKey=auditRouteKey\(route\)/);
  assert.match(audit,/selectLockedRoute\(radar,lockedKey\)/);
  assert.match(audit,/liveState='missing'/);
  assert.match(audit,/O app não troca para outra moeda/);
  assert.match(audit,/Atualizar agora/);
  assert.match(audit,/navigator\.clipboard\.writeText/);
});
