const CLEAN_SYMBOL=/[^A-Z0-9]/g;

export function splitUsdtSymbol(symbol){
  const normalized=String(symbol||'').toUpperCase().replace(CLEAN_SYMBOL,'');
  if(!normalized.endsWith('USDT') || normalized.length<=4) return null;
  return {symbol:normalized,base:normalized.slice(0,-4),quote:'USDT'};
}

export function exchangeTradeUrl(exchange,symbol){
  const pair=splitUsdtSymbol(symbol);
  if(!pair) return null;
  const {base}=pair;
  const key=String(exchange||'').toLowerCase();

  if(key==='binance') return `https://www.binance.com/en/trade/${base}_USDT`;
  if(key==='bybit') return `https://www.bybit.com/en/trade/spot/${base}/USDT`;
  if(key==='okx') return `https://www.okx.com/en-br/trade-spot/${base.toLowerCase()}-usdt`;
  if(key==='gate') return `https://www.gate.com/trade/${base}_USDT`;
  if(key==='kucoin') return `https://www.kucoin.com/trade/${base}-USDT`;
  if(key==='bitget') return `https://www.bitget.com/markets/spot/${base}USDT`;
  if(key==='htx') return `https://www.htx.com/trade/${base.toLowerCase()}_usdt/`;
  return null;
}
