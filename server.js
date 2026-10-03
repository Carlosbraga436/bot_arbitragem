import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCommonUsdtMarkets,
  createMarketHub,
  MAX_MONITORED_SYMBOLS,
  selectConfirmedSymbols,
} from './src/market-hub.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8787);

const BINANCE_BASES = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
];
const BYBIT_BASES = ['https://api.bybit.com','https://api.bytick.com'];
const REQUEST_TIMEOUT_MS = 10_000;
const APP_VERSION = '0.17.0-recovery.1';

let runtimePromise = null;

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': `radar-cripto-carlos/${APP_VERSION}` },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
    return await r.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchFirst(bases, path) {
  const errors = [];
  for (const base of bases) {
    try {
      return { base, data: await fetchJson(`${base}${path}`) };
    } catch (error) {
      errors.push(`${base}: ${error?.message || error}`);
    }
  }
  throw new Error(errors.join(' | '));
}

async function getCatalog() {
  const [binanceInfoResult, bybitInfoResult, binanceTickerResult, bybitTickerResult] = await Promise.all([
    fetchFirst(BINANCE_BASES, '/api/v3/exchangeInfo'),
    fetchFirst(BYBIT_BASES, '/v5/market/instruments-info?category=spot&limit=1000'),
    fetchFirst(BINANCE_BASES, '/api/v3/ticker/24hr'),
    fetchFirst(BYBIT_BASES, '/v5/market/tickers?category=spot'),
  ]);

  const binanceSymbols = binanceInfoResult.data?.symbols || [];
  const bybitSymbols = bybitInfoResult.data?.result?.list || [];
  const binanceTickers = Array.isArray(binanceTickerResult.data) ? binanceTickerResult.data : [];
  const bybitTickers = bybitTickerResult.data?.result?.list || [];

  const candidates = buildCommonUsdtMarkets({
    binanceSymbols,
    bybitSymbols,
    binanceTickers,
    bybitTickers,
  });
  const monitoredSymbols = selectConfirmedSymbols(candidates, MAX_MONITORED_SYMBOLS);

  const binanceActiveUsdt = binanceSymbols.filter(
    (x) => x?.status === 'TRADING' && x?.quoteAsset === 'USDT'
  ).length;
  const bybitActiveUsdt = bybitSymbols.filter(
    (x) => x?.status === 'Trading' && x?.quoteCoin === 'USDT'
  ).length;

  return {
    generatedAt: Date.now(),
    version: APP_VERSION,
    sources: {
      binance: binanceInfoResult.base,
      bybit: bybitInfoResult.base,
    },
    universeMode: 'dynamic_common_spot_usdt',
    maxMonitored: MAX_MONITORED_SYMBOLS,
    exchangeUniverse: {
      binanceActiveUsdt,
      bybitActiveUsdt,
      commonActiveUsdt: candidates.length,
    },
    candidates,
    monitoredSymbols,
    confirmed: candidates.length,
    pending: 0,
  };
}

async function ensureRuntime() {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const catalog = await getCatalog();
      if (!catalog.monitoredSymbols.length) {
        throw new Error('Nenhum mercado spot USDT comum confirmado para monitoramento.');
      }

      const marketHub = createMarketHub({ symbols: catalog.monitoredSymbols });
      marketHub.start();

      console.log(
        `[catalog] ${catalog.exchangeUniverse.commonActiveUsdt} pares comuns USDT; monitorando ${catalog.monitoredSymbols.length}/${catalog.maxMonitored}`
      );

      return { catalog, marketHub };
    })().catch((error) => {
      runtimePromise = null;
      throw error;
    });
  }
  return runtimePromise;
}

async function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const safe = normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '');
  const path = join(PUBLIC, safe);
  if (!path.startsWith(PUBLIC)) return json(res, 403, { error: 'forbidden' });

  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error('not file');
    const data = await readFile(path);
    const type = ({
      '.html':'text/html; charset=utf-8',
      '.js':'text/javascript; charset=utf-8',
      '.css':'text/css; charset=utf-8',
    })[extname(path)] || 'application/octet-stream';

    res.writeHead(200, { 'content-type': type, 'cache-control':'no-store' });
    res.end(data);
  } catch {
    json(res, 404, { error: 'not_found' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (url.pathname === '/api/health') {
      return json(res, 200, {
        ok: true,
        mode: 'simulation-only',
        ordersEnabled: false,
        version: APP_VERSION,
      });
    }

    if (url.pathname === '/api/catalog') {
      const { catalog } = await ensureRuntime();
      return json(res, 200, catalog);
    }

    if (url.pathname === '/api/market') {
      const { marketHub } = await ensureRuntime();
      return json(res, 200, marketHub.snapshot());
    }

    if (url.pathname === '/api/reconnect' && req.method === 'POST') {
      const { marketHub } = await ensureRuntime();
      marketHub.reconnect();
      return json(res, 202, { ok: true, message: 'reconnect_requested' });
    }

    if (url.pathname === '/api/reference') {
      const { catalog } = await ensureRuntime();
      return json(res, 200, {
        mode: 'public-market-data-only',
        version: APP_VERSION,
        universeMode: catalog.universeMode,
        binanceRest: BINANCE_BASES,
        bybitRest: BYBIT_BASES,
        binanceWs: 'wss://stream.binance.com:443/ws',
        bybitWs: 'wss://stream.bybit.com/v5/public/spot',
        monitoredCount: catalog.monitoredSymbols.length,
        commonActiveUsdt: catalog.exchangeUniverse.commonActiveUsdt,
      });
    }

    if (url.pathname === '/src/core.js') {
      const data = await readFile(join(ROOT, 'src', 'core.js'));
      res.writeHead(200, {
        'content-type':'text/javascript; charset=utf-8',
        'cache-control':'no-store',
      });
      return res.end(data);
    }

    return await serveStatic(url.pathname, res);
  } catch (error) {
    return json(res, 502, {
      error: 'upstream_unavailable',
      message: error?.message || String(error),
    });
  }
});

for (const signal of ['SIGTERM','SIGINT']) {
  process.on(signal, () => {
    Promise.resolve(runtimePromise)
      .then((runtime) => runtime?.marketHub?.stop())
      .catch(() => {})
      .finally(() => server.close(() => process.exit(0)));
  });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Radar Cripto em 0.0.0.0:${PORT}`);
  ensureRuntime().catch((error) => {
    console.warn('[runtime] inicialização falhou:', error?.message || error);
  });
});
