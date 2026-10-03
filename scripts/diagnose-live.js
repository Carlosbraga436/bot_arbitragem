const TIMEOUT_MS = 10_000;

const BINANCE_REST = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
];

const BYBIT_REST = [
  'https://api.bybit.com',
  'https://api.bytick.com',
];

function elapsed(start) {
  return Date.now() - start;
}

async function probeRest(name, bases, path, validate) {
  const attempts = [];
  for (const base of bases) {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(`${base}${path}`, {
        signal: controller.signal,
        headers: { 'user-agent': 'radar-cripto-carlos-live-diagnostic/0.16' },
      });
      const latencyMs = elapsed(start);
      if (!response.ok) {
        attempts.push({ base, ok:false, latencyMs, error:`HTTP ${response.status}` });
        continue;
      }
      const data = await response.json();
      const valid = Boolean(validate(data));
      attempts.push({ base, ok:valid, latencyMs, error: valid ? null : 'payload_invalido' });
      if (valid) return { name, ok:true, selected:base, attempts };
    } catch (error) {
      attempts.push({ base, ok:false, latencyMs:elapsed(start), error:error?.name === 'AbortError' ? 'timeout' : (error?.message || String(error)) });
    } finally {
      clearTimeout(timer);
    }
  }
  return { name, ok:false, selected:null, attempts };
}

function probeWs(name, url, onOpen) {
  return new Promise((resolve) => {
    const start = Date.now();
    let settled = false;
    let ws;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws?.close(); } catch {}
      resolve({ name, latencyMs:elapsed(start), ...result });
    };
    const timer = setTimeout(() => finish({ ok:false, error:'timeout' }), TIMEOUT_MS);

    try {
      ws = new WebSocket(url);
      ws.addEventListener('open', () => {
        try { onOpen?.(ws); } catch (error) { finish({ok:false,error:error.message}); }
      });
      ws.addEventListener('message', (event) => {
        try {
          const msg = JSON.parse(String(event.data));
          if (name === 'binance_ws') {
            if (Array.isArray(msg?.bids) && Array.isArray(msg?.asks)) finish({ ok:true, error:null });
          } else if (name === 'bybit_ws') {
            if (msg?.topic === 'orderbook.1.BTCUSDT' && msg?.data?.s === 'BTCUSDT') finish({ ok:true, error:null });
          }
        } catch {}
      });
      ws.addEventListener('error', () => finish({ ok:false, error:'websocket_error' }));
      ws.addEventListener('close', () => {
        if (!settled) finish({ ok:false, error:'closed_before_market_data' });
      });
    } catch (error) {
      finish({ ok:false, error:error?.message || String(error) });
    }
  });
}

const startedAt = new Date().toISOString();

const [binanceRest, bybitRest, binanceWs, bybitWs] = await Promise.all([
  probeRest(
    'binance_rest',
    BINANCE_REST,
    '/api/v3/exchangeInfo?symbol=BTCUSDT',
    (data) => Array.isArray(data?.symbols) && data.symbols.some((x) => x.symbol === 'BTCUSDT' && x.status === 'TRADING')
  ),
  probeRest(
    'bybit_rest',
    BYBIT_REST,
    '/v5/market/instruments-info?category=spot&symbol=BTCUSDT',
    (data) => data?.retCode === 0 && Array.isArray(data?.result?.list) && data.result.list.some((x) => x.symbol === 'BTCUSDT' && x.status === 'Trading')
  ),
  probeWs(
    'binance_ws',
    'wss://stream.binance.com:9443/ws/btcusdt@depth5@100ms'
  ),
  probeWs(
    'bybit_ws',
    'wss://stream.bybit.com/v5/public/spot',
    (ws) => ws.send(JSON.stringify({ op:'subscribe', args:['orderbook.1.BTCUSDT'] }))
  ),
]);

const checks = [binanceRest, bybitRest, binanceWs, bybitWs];
const report = {
  program:'Radar Cripto — diagnóstico live',
  version:'0.16.0-recovery.1',
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

console.log(JSON.stringify(report, null, 2));

if (!report.summary.allPassed) {
  process.exitCode = 1;
}
