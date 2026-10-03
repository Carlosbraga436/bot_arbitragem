import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8787);

const BINANCE_BASES = ['https://data-api.binance.vision','https://api.binance.com','https://api1.binance.com','https://api2.binance.com'];
const BYBIT_BASES = ['https://api.bybit.com','https://api.bytick.com'];
const REQUEST_TIMEOUT_MS = 8_000;

const CANONICAL = [
  ['BTC','Bitcoin'],['ETH','Ethereum'],['SOL','Solana'],['XRP','XRP'],['DOGE','Dogecoin'],
  ['ADA','Cardano'],['AVAX','Avalanche'],['LINK','Chainlink'],['BCH','Bitcoin Cash'],['LTC','Litecoin'],
  ['DOT','Polkadot'],['TRX','TRON'],['TON','Toncoin'],['SHIB','Shiba Inu'],['NEAR','NEAR Protocol'],
  ['SUI','Sui'],['PEPE','Pepe'],['AAVE','Aave'],['UNI','Uniswap'],['ARB','Arbitrum'],
  ['OP','Optimism'],['ETC','Ethereum Classic'],['ATOM','Cosmos'],['FIL','Filecoin'],['LUNC','Terra Luna Classic'],
].map(([base, name]) => ({ base, name, symbol: `${base}USDT`, quote: 'USDT' }));

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
    const r = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'radar-cripto-carlos/0.16-recovery' } });
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
  const [binanceResult, bybitResult] = await Promise.all([
    fetchFirst(BINANCE_BASES, '/api/v3/exchangeInfo'),
    fetchFirst(BYBIT_BASES, '/v5/market/instruments-info?category=spot'),
  ]);
  const binance = binanceResult.data;
  const bybit = bybitResult.data;

  const bMap = new Map((binance.symbols || []).map((x) => [x.symbol, x]));
  const yList = bybit?.result?.list || [];
  const yMap = new Map(yList.map((x) => [x.symbol, x]));

  const candidates = CANONICAL.map((asset) => {
    const b = bMap.get(asset.symbol);
    const y = yMap.get(asset.symbol);
    const binanceActive = Boolean(b && b.status === 'TRADING' && b.quoteAsset === 'USDT' && b.baseAsset === asset.base);
    const bybitActive = Boolean(y && y.status === 'Trading' && y.quoteCoin === 'USDT' && y.baseCoin === asset.base);
    return {
      ...asset,
      binanceActive,
      bybitActive,
      identityConfirmed: binanceActive && bybitActive,
      identityMethod: binanceActive && bybitActive ? 'canonical_registry+exchange_catalogs' : 'pending',
    };
  });

  return {
    generatedAt: Date.now(),
    sources: { binance: binanceResult.base, bybit: bybitResult.base },
    candidates,
    confirmed: candidates.filter((x) => x.identityConfirmed).length,
    pending: candidates.filter((x) => !x.identityConfirmed).length,
  };
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
    const type = ({ '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' })[extname(path)] || 'application/octet-stream';
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
      return json(res, 200, { ok: true, mode: 'simulation-only', ordersEnabled: false, version: '0.16.0-recovery.1' });
    }
    if (url.pathname === '/api/catalog') {
      return json(res, 200, await getCatalog());
    }
    if (url.pathname === '/api/reference') {
      return json(res, 200, {
        mode: 'public-market-data-only',
        binanceRest: BINANCE_BASES,
        bybitRest: BYBIT_BASES,
        binanceWs: 'wss://stream.binance.com:9443/stream',
        bybitWs: 'wss://stream.bybit.com/v5/public/spot',
      });
    }
    if (url.pathname === '/src/core.js') {
      const data = await readFile(join(ROOT, 'src', 'core.js'));
      res.writeHead(200, { 'content-type':'text/javascript; charset=utf-8', 'cache-control':'no-store' });
      return res.end(data);
    }
    return await serveStatic(url.pathname, res);
  } catch (error) {
    return json(res, 502, { error: 'upstream_unavailable', message: error?.message || String(error) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Radar Cripto em http://127.0.0.1:${PORT}`);
});
