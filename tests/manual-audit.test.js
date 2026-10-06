import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { exchangeTradeUrl, splitUsdtSymbol } from '../public/exchange-links.js';

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

test('CP29 mantém snapshot manual separado do polling e expõe ações de auditoria', async () => {
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const audit=await readFile(new URL('../public/manual-audit.js',import.meta.url),'utf8');

  for(const id of ['manualAudit','manualAuditBody','manualAuditRefresh','manualAuditCopy']){
    assert.match(html,new RegExp('id=["\\\']'+id+'["\\\']'));
  }
  assert.match(app,/createManualAuditController/);
  assert.match(app,/manualCheckBtn/);
  assert.match(audit,/snapshot=cloneRoute\(route\)/);
  assert.match(audit,/capturedAt=Date\.now\(\)/);
  assert.match(audit,/Atualizar snapshot/);
  assert.match(audit,/navigator\.clipboard\.writeText/);
});
