import { DEFAULT_COSTS, DEFAULT_RULES, evaluatePair, topPositive } from '/src/core.js';

const state = {
  budget: 100,
  catalog: [],
  monitored: [],
  commonActiveUsdt: 0,
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
  state.commonActiveUsdt = Number(data?.exchangeUniverse?.candidateUsdt ?? data?.exchangeUniverse?.commonActiveUsdt) || state.catalog.length;

  const bySymbol = new Map(state.catalog.map((x) => [x.symbol, x]));
  const runtimeSymbols = Array.isArray(data.monitoredSymbols) ? data.monitoredSymbols : [];
  state.monitored = runtimeSymbols.map((symbol) => bySymbol.get(symbol)).filter(Boolean);

  $('identity').textContent = `${state.monitored.length} pares`;
  $('summary').textContent = `${state.monitored.length} pares USDT sendo sondados nas duas exchanges`;

  if (!state.monitored.length) throw new Error('Nenhum par spot USDT comum confirmado nos catálogos.');

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
  const finite = results.filter((r) => Number.isFinite(r?.netPnlUsdt));
  const liquidComparable = finite.length;
  const liveBoth = state.monitored.filter((asset) =>
    state.books.binance.has(asset.symbol) && state.books.bybit.has(asset.symbol)
  ).length;
  const nearest = [...finite]
    .sort((a,b)=>(b.netPnlUsdt??-Infinity)-(a.netPnlUsdt??-Infinity))
    .slice(0,5);

  const breakEvenApproxPct =
    DEFAULT_COSTS.binanceFeePct +
    DEFAULT_COSTS.bybitFeePct +
    (DEFAULT_COSTS.reservePct * 2) +
    ((DEFAULT_COSTS.recompositionUsdt / state.budget) * 100);

  $('identity').textContent = `${liveBoth} comuns`;
  $('summary').textContent =
    `${state.monitored.length} sondadas · ${liveBoth} com cotação nas duas · ${liquidComparable} com liquidez p/ ${state.budget.toLocaleString('pt-BR')} USDT · ${positives.length} elegíveis`;
  $('breakEven').textContent = `Breakeven aproximado no modelo atual: ${fmt(breakEvenApproxPct,3)}% de spread bruto.`;

  const best = positives[0];
  const bestObserved = nearest[0];
  if (best) {
    $('best').innerHTML = `<h2>${best.symbol} <span class="profit">${money(best.netPnlUsdt)}</span></h2><p>Comprar ${best.buyExchange} @ ${fmt(best.buyVwap,8)} · vender ${best.sellExchange} @ ${fmt(best.sellVwap,8)} · ROI capital ${fmt(best.roiOnTotalCapitalPct,3)}%</p>`;
  } else if (bestObserved) {
    const grossPct = (bestObserved.grossPnlUsdt / state.budget) * 100;
    $('best').innerHTML = `<h2>${bestObserved.symbol}</h2><p>Melhor candidata agora: spread bruto ${grossPct >= 0 ? '+' : ''}${fmt(grossPct,3)}%, líquido ${money(bestObserved.netPnlUsdt)}. Ainda abaixo do breakeven aproximado de ${fmt(breakEvenApproxPct,3)}%.</p>`;
  } else {
    $('best').innerHTML = '<h2>—</h2><p>Aguardando pares com cotação recente e liquidez suficiente nas duas exchanges.</p>';
  }

  const shown = positives.length ? positives : nearest;
  $('tableTitle').textContent = positives.length ? 'Top 5 oportunidades elegíveis' : '5 mais próximas do breakeven';
  $('rows').innerHTML = shown.length
    ? shown.map((r) => {
        const cls = r.eligible ? 'pos' : 'neg';
        const status = r.eligible ? 'elegível' : 'não elegível';
        return `<tr><td><b>${r.symbol}</b></td><td>${r.buyExchange}</td><td>${r.sellExchange}</td><td>${fmt(r.buyVwap,8)}</td><td>${fmt(r.sellVwap,8)}</td><td class="${cls}">${money(r.netPnlUsdt)}</td><td class="${cls}">${fmt(r.roiOnTotalCapitalPct,3)}%</td><td>${status}</td></tr>`;
      }).join('')
    : '<tr><td colspan="8">Nenhum par com dados e liquidez completos neste instante.</td></tr>';
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
