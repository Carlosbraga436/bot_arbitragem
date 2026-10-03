import { DEFAULT_COSTS, DEFAULT_RULES, applyOrderBookMessage, evaluatePair, topPositive } from '/src/core.js';

const state = {
  budget: 100,
  catalog: [],
  monitored: [],
  books: { binance: new Map(), bybit: new Map() },
  sockets: { binance: null, bybit: null },
  last: { binance: null, bybit: null },
};

const $ = (id) => document.getElementById(id);
const fmt = (n, d=4) => Number.isFinite(n) ? n.toLocaleString('pt-BR',{minimumFractionDigits:d,maximumFractionDigits:d}) : '—';
const money = (n) => Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${fmt(n,2)} USDT` : '—';

function setStatus(exchange, kind, text) {
  const el = $(`${exchange}Status`);
  el.className = `dot ${kind}`;
  el.textContent = text;
}

function touch(exchange, ts = Date.now()) {
  state.last[exchange] = ts;
  $(`${exchange}Last`).textContent = `Última cotação: ${new Date(ts).toLocaleTimeString('pt-BR')}`;
}

function closeSockets() {
  for (const ws of Object.values(state.sockets)) try { ws?.close(); } catch {}
  state.sockets = { binance: null, bybit: null };
}

function connectBinance(symbols) {
  const streams = symbols.map((s) => `${s.toLowerCase()}@depth20@100ms`).join('/');
  const ws = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);
  state.sockets.binance = ws;
  setStatus('binance','pending','Conectando');
  ws.onopen = () => setStatus('binance','ok','Conectado');
  ws.onerror = () => setStatus('binance','bad','Erro');
  ws.onclose = () => setStatus('binance','bad','Desconectado');
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const stream = msg.stream || '';
    const symbol = stream.split('@')[0]?.toUpperCase();
    const d = msg.data;
    if (!symbol || !d?.bids || !d?.asks) return;
    const ts = Date.now();
    state.books.binance.set(symbol, { bids:d.bids, asks:d.asks, ts });
    touch('binance', ts);
    render();
  };
}

function connectBybit(symbols) {
  const ws = new WebSocket('wss://stream.bybit.com/v5/public/spot');
  state.sockets.bybit = ws;
  let heartbeat;
  setStatus('bybit','pending','Conectando');
  ws.onopen = () => {
    setStatus('bybit','ok','Conectado');
    ws.send(JSON.stringify({ op:'subscribe', args:symbols.map((s)=>`orderbook.50.${s}`) }));
    heartbeat = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op:'ping' })); }, 20_000);
  };
  ws.onerror = () => setStatus('bybit','bad','Erro');
  ws.onclose = () => { clearInterval(heartbeat); setStatus('bybit','bad','Desconectado'); };
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (!msg.topic?.startsWith('orderbook.')) return;
    const d = msg.data;
    if (!d?.s || !d?.b || !d?.a) return;
    const receivedAt = Date.now();
    const next = applyOrderBookMessage(
      state.books.bybit.get(d.s),
      { bids:d.b, asks:d.a, ts:receivedAt },
      msg.type || 'snapshot',
      50
    );
    if (!next) return;
    state.books.bybit.set(d.s, next);
    touch('bybit', receivedAt);
    render();
  };
}

function scoreCandidates(candidates) {
  const preferred = ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','BCHUSDT','LTCUSDT','DOTUSDT','TRXUSDT','TONUSDT','SHIBUSDT','NEARUSDT'];
  return [...candidates].sort((a,b) => {
    const ai = preferred.indexOf(a.symbol), bi = preferred.indexOf(b.symbol);
    const av = ai === -1 ? 999 : ai, bv = bi === -1 ? 999 : bi;
    return av - bv || a.symbol.localeCompare(b.symbol);
  });
}

async function bootstrap() {
  closeSockets();
  state.books.binance.clear(); state.books.bybit.clear();
  const r = await fetch('/api/catalog', { cache:'no-store' });
  if (!r.ok) throw new Error(`Catálogo HTTP ${r.status}`);
  const data = await r.json();
  state.catalog = data.candidates || [];
  const confirmed = scoreCandidates(state.catalog.filter((x)=>x.identityConfirmed));
  state.monitored = confirmed.slice(0,15);
  $('identity').textContent = `${confirmed.length}/${state.catalog.length} identidades`;
  $('summary').textContent = `${state.monitored.length} monitoradas · ${state.catalog.length} candidatas · somente identidades confirmadas`;
  if (!state.monitored.length) throw new Error('Nenhum par comum confirmado nos catálogos.');
  const symbols = state.monitored.map((x)=>x.symbol);
  connectBinance(symbols);
  connectBybit(symbols);
  render();
}

function currentResults() {
  const now = Date.now();
  return state.monitored.map((asset) => evaluatePair({
    symbol: asset.symbol,
    identityConfirmed: asset.identityConfirmed,
    binanceBook: state.books.binance.get(asset.symbol),
    bybitBook: state.books.bybit.get(asset.symbol),
    budgetUsdt: state.budget,
    costs: DEFAULT_COSTS,
    rules: DEFAULT_RULES,
    now,
  }));
}

function render() {
  const results = currentResults();
  const positives = topPositive(results,5);
  const comparable = results.filter((r)=>r.reason !== 'invalid_data' && !['stale_data','desynced_data'].includes(r.reason)).length;
  $('summary').textContent = `${state.monitored.length} monitoradas · ${comparable} comparáveis agora · ${positives.length} positivas elegíveis`;

  const best = positives[0];
  $('best').innerHTML = best
    ? `<h2>${best.symbol} <span class="profit">${money(best.netPnlUsdt)}</span></h2><p>Comprar ${best.buyExchange} @ ${fmt(best.buyVwap,8)} · vender ${best.sellExchange} @ ${fmt(best.sellVwap,8)} · ROI capital ${fmt(best.roiOnTotalCapitalPct,3)}%</p>`
    : '<h2>—</h2><p>Nenhuma estimativa positiva elegível no momento.</p>';

  const rows = [...results].sort((a,b)=>(b.netPnlUsdt??-Infinity)-(a.netPnlUsdt??-Infinity));
  $('rows').innerHTML = rows.map((r)=>{
    const cls = r.eligible ? 'pos' : (Number.isFinite(r.netPnlUsdt) ? 'neg' : 'muted');
    return `<tr><td><b>${r.symbol}</b></td><td>${r.buyExchange || '—'}</td><td>${r.sellExchange || '—'}</td><td>${fmt(r.buyVwap,8)}</td><td>${fmt(r.sellVwap,8)}</td><td class="${cls}">${money(r.netPnlUsdt)}</td><td class="${cls}">${Number.isFinite(r.roiOnTotalCapitalPct)?fmt(r.roiOnTotalCapitalPct,3)+'%':'—'}</td><td>${r.reason}</td></tr>`;
  }).join('') || '<tr><td colspan="8">Aguardando catálogo.</td></tr>';
}

for (const btn of document.querySelectorAll('[data-budget]')) {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-budget]').forEach((x)=>x.classList.remove('active'));
    btn.classList.add('active');
    state.budget = Number(btn.dataset.budget);
    $('budgetLabel').textContent = state.budget.toLocaleString('pt-BR');
    $('capital').textContent = (state.budget*2).toLocaleString('pt-BR');
    render();
  });
}
$('reconnect').addEventListener('click', () => bootstrap().catch(showFatal));

function showFatal(error) {
  $('summary').textContent = `Falha segura: ${error.message}`;
  setStatus('binance','bad','Indisponível');
  setStatus('bybit','bad','Indisponível');
}

bootstrap().catch(showFatal);
