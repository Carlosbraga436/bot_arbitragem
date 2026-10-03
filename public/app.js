import { DEFAULT_COSTS, DEFAULT_RULES, evaluatePair, topPositive } from '/src/core.js';

const state = {
  budget: 100,
  catalog: [],
  monitored: [],
  books: { binance: new Map(), bybit: new Map() },
  pollTimer: null,
};

const $ = (id) => document.getElementById(id);
const fmt = (n, d=4) => Number.isFinite(n) ? n.toLocaleString('pt-BR',{minimumFractionDigits:d,maximumFractionDigits:d}) : '—';
const money = (n) => Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${fmt(n,2)} USDT` : '—';

function setStatus(exchange, kind, text) {
  const el = $(`${exchange}Status`);
  el.className = `dot ${kind}`;
  el.textContent = text;
}

function touch(exchange, ts) {
  const el = $(`${exchange}Last`);
  el.textContent = ts ? `Última cotação: ${new Date(ts).toLocaleTimeString('pt-BR')}` : 'Última cotação: —';
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

function applyStatus(exchange, remote) {
  const last = Number(remote?.last) || null;
  touch(exchange, last);

  if (remote?.state === 'connected') {
    setStatus(exchange, 'ok', 'Conectado');
    return;
  }
  if (remote?.state === 'connecting' || remote?.state === 'idle') {
    setStatus(exchange, 'pending', 'Conectando');
    return;
  }
  setStatus(exchange, 'bad', 'Indisponível');
}

function scoreCandidates(candidates) {
  const preferred = ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','BCHUSDT','LTCUSDT','DOTUSDT','TRXUSDT','TONUSDT','SHIBUSDT','NEARUSDT'];
  return [...candidates].sort((a,b) => {
    const ai = preferred.indexOf(a.symbol), bi = preferred.indexOf(b.symbol);
    const av = ai === -1 ? 999 : ai, bv = bi === -1 ? 999 : bi;
    return av - bv || a.symbol.localeCompare(b.symbol);
  });
}

function ingestBooks(exchange, incoming = {}) {
  const allowed = new Set(state.monitored.map((x)=>x.symbol));
  const target = state.books[exchange];
  for (const [symbol, book] of Object.entries(incoming)) {
    if (!allowed.has(symbol)) continue;
    if (!Array.isArray(book?.bids) || !Array.isArray(book?.asks) || !Number.isFinite(Number(book?.ts))) continue;
    target.set(symbol, {
      bids: book.bids,
      asks: book.asks,
      ts: Number(book.ts),
    });
  }
}

async function fetchMarket() {
  const r = await fetch('/api/market', { cache:'no-store' });
  if (!r.ok) throw new Error(`Mercado HTTP ${r.status}`);
  const data = await r.json();

  ingestBooks('binance', data?.books?.binance);
  ingestBooks('bybit', data?.books?.bybit);
  applyStatus('binance', data?.status?.binance);
  applyStatus('bybit', data?.status?.bybit);
  render();
}

async function startPolling() {
  await fetchMarket();
  state.pollTimer = setInterval(() => {
    fetchMarket().catch((error) => {
      console.warn('Falha ao atualizar mercado:', error);
    });
  }, 1_000);
}

async function bootstrap() {
  stopPolling();
  state.books.binance.clear();
  state.books.bybit.clear();
  setStatus('binance','pending','Conectando');
  setStatus('bybit','pending','Conectando');
  touch('binance', null);
  touch('bybit', null);

  const r = await fetch('/api/catalog', { cache:'no-store' });
  if (!r.ok) {
    const body = await r.json().catch(() => null);
    throw new Error(body?.message || `Catálogo HTTP ${r.status}`);
  }

  const data = await r.json();
  state.catalog = data.candidates || [];
  const confirmed = scoreCandidates(state.catalog.filter((x)=>x.identityConfirmed));
  const bySymbol = new Map(state.catalog.map((x) => [x.symbol, x]));
  const runtimeSymbols = Array.isArray(data.monitoredSymbols) && data.monitoredSymbols.length
    ? data.monitoredSymbols
    : confirmed.slice(0,15).map((x)=>x.symbol);
  state.monitored = runtimeSymbols.map((symbol) => bySymbol.get(symbol)).filter(Boolean);

  $('identity').textContent = `${confirmed.length}/${state.catalog.length} identidades`;
  $('summary').textContent = `${state.monitored.length} monitoradas · ${state.catalog.length} candidatas · somente identidades confirmadas`;

  if (!state.monitored.length) throw new Error('Nenhum par comum confirmado nos catálogos.');

  await startPolling();
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

$('reconnect').addEventListener('click', async () => {
  try {
    await fetch('/api/reconnect', { method:'POST' });
  } catch {}
  bootstrap().catch(showFatal);
});

function showFatal(error) {
  stopPolling();
  $('summary').textContent = `Falha segura: ${error.message}`;
  setStatus('binance','bad','Indisponível');
  setStatus('bybit','bad','Indisponível');
}

bootstrap().catch(showFatal);
