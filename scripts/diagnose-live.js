const TIMEOUT_MS = 10_000;

const BYBIT_REST = ['https://api.bybit.com','https://api.bytick.com'];
const OKX_REST = ['https://www.okx.com','https://openapi.okx.com'];
const GATE_REST = ['https://api.gateio.ws/api/v4'];

function elapsed(start) {
  return Date.now() - start;
}

async function probeRest(name,bases,path,validate) {
  const attempts=[];
  for (const base of bases) {
    const start=Date.now();
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),TIMEOUT_MS);
    try {
      const response=await fetch(`${base}${path}`,{
        signal:controller.signal,
        headers:{'user-agent':'radar-cripto-carlos-live-diagnostic/0.18'},
      });
      const latencyMs=elapsed(start);
      if (!response.ok) {
        attempts.push({base,ok:false,latencyMs,error:`HTTP ${response.status}`});
        continue;
      }
      const data=await response.json();
      const valid=Boolean(validate(data));
      attempts.push({base,ok:valid,latencyMs,error:valid?null:'payload_invalido'});
      if (valid) return {name,ok:true,selected:base,attempts};
    } catch(error) {
      attempts.push({
        base,ok:false,latencyMs:elapsed(start),
        error:error?.name==='AbortError'?'timeout':(error?.message||String(error)),
      });
    } finally {
      clearTimeout(timer);
    }
  }
  return {name,ok:false,selected:null,attempts};
}

function probeWs(name,url,onOpen,validateMessage) {
  return new Promise((resolve)=>{
    const start=Date.now();
    let settled=false;
    let ws;

    const finish=(result)=>{
      if (settled) return;
      settled=true;
      clearTimeout(timer);
      try { ws?.close(); } catch {}
      resolve({name,latencyMs:elapsed(start),...result});
    };

    const timer=setTimeout(()=>finish({ok:false,error:'timeout'}),TIMEOUT_MS);

    try {
      ws=new WebSocket(url);
      ws.addEventListener('open',()=>{
        try { onOpen?.(ws); } catch(error) { finish({ok:false,error:error.message}); }
      });
      ws.addEventListener('message',(event)=>{
        try {
          const msg=JSON.parse(String(event.data));
          if (validateMessage(msg)) finish({ok:true,error:null});
        } catch {}
      });
      ws.addEventListener('error',()=>finish({ok:false,error:'websocket_error'}));
      ws.addEventListener('close',()=>{
        if (!settled) finish({ok:false,error:'closed_before_market_data'});
      });
    } catch(error) {
      finish({ok:false,error:error?.message||String(error)});
    }
  });
}

const startedAt=new Date().toISOString();

const [binanceWs,bybitRest,okxRest,gateRest,gateWs]=await Promise.all([
  probeWs(
    'binance_ws',
    'wss://stream.binance.com:443/ws/btcusdt@bookTicker',
    null,
    (msg)=>msg?.s==='BTCUSDT' && Number(msg?.b)>0 && Number(msg?.a)>0 && Number(msg?.B)>0 && Number(msg?.A)>0,
  ),
  probeRest(
    'bybit_rest',
    BYBIT_REST,
    '/v5/market/tickers?category=spot&symbol=BTCUSDT',
    (data)=>data?.retCode===0 && data?.result?.list?.some(
      (x)=>x.symbol==='BTCUSDT' && Number(x.bid1Price)>0 && Number(x.ask1Price)>0
    ),
  ),
  probeRest(
    'okx_rest',
    OKX_REST,
    '/api/v5/market/ticker?instId=BTC-USDT',
    (data)=>data?.code==='0' && data?.data?.some(
      (x)=>x.instId==='BTC-USDT' && Number(x.bidPx)>0 && Number(x.askPx)>0
    ),
  ),
  probeRest(
    'gate_rest',
    GATE_REST,
    '/spot/currency_pairs/BTC_USDT',
    (data)=>data?.id==='BTC_USDT' && data?.trade_status==='tradable',
  ),
  probeWs(
    'gate_ws',
    'wss://api.gateio.ws/ws/v4/',
    (ws)=>ws.send(JSON.stringify({
      time:Math.floor(Date.now()/1000),
      channel:'spot.book_ticker',
      event:'subscribe',
      payload:['BTC_USDT'],
    })),
    (msg)=>msg?.channel==='spot.book_ticker'
      && msg?.event==='update'
      && msg?.result?.s==='BTC_USDT'
      && Number(msg?.result?.b)>0
      && Number(msg?.result?.a)>0
      && Number(msg?.result?.B)>0
      && Number(msg?.result?.A)>0,
  ),
]);

const checks=[binanceWs,bybitRest,okxRest,gateRest,gateWs];
const report={
  program:'Radar Cripto — diagnóstico live multi-exchange',
  version:'0.18.0-recovery.1',
  startedAt,
  finishedAt:new Date().toISOString(),
  node:process.version,
  platform:`${process.platform}/${process.arch}`,
  checks,
  summary:{
    passed:checks.filter((x)=>x.ok).length,
    total:checks.length,
    allPassed:checks.every((x)=>x.ok),
  },
  safety:{
    apiKeysUsed:false,
    ordersSent:false,
    marketDataOnly:true,
  },
};

console.log(JSON.stringify(report,null,2));
if (!report.summary.allPassed) process.exitCode=1;
