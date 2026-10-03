import {
  DEFAULT_COSTS,
  DEFAULT_RULES,
  evaluateAcrossExchanges,
  exchangeFeePct,
  topPositive,
} from '/src/core.js';

const EXCHANGES = ['binance','bybit','okx','gate','kucoin'];

const state = {
  budget:100,
  catalog:[],
  monitored:[],
  books:Object.fromEntries(EXCHANGES.map((x)=>[x,new Map()])),
  pollTimer:null,
};

const $=(id)=>document.getElementById(id);
const fmt=(n,d=4)=>Number.isFinite(n)
  ? n.toLocaleString('pt-BR',{minimumFractionDigits:d,maximumFractionDigits:d})
  : '—';
const money=(n)=>Number.isFinite(n)?`${n>=0?'+':''}${fmt(n,2)} USDT`:'—';
const exchangeLabel=(name)=>({
  binance:'Binance',
  bybit:'Bybit',
  okx:'OKX',
  gate:'Gate.io',
}[name]||name||'—');

const spreadPct=(r)=>Number.isFinite(r?.grossPnlUsdt)&&Number.isFinite(r?.budgetUsdt)&&r.budgetUsdt>0
  ? (r.grossPnlUsdt/r.budgetUsdt)*100
  : null;

const directionLabel=(r)=>r?.buyExchange&&r?.sellExchange
  ? `${exchangeLabel(r.buyExchange)} → ${exchangeLabel(r.sellExchange)}`
  : '—';

function costsForAsset(asset) {
  return {
    ...DEFAULT_COSTS,
    exchangeFeePct:{
      ...DEFAULT_COSTS.exchangeFeePct,
      ...(asset?.feePctByExchange || {}),
    },
  };
}

function routeBreakEvenPct(r, asset = null) {
  if (!r?.buyExchange || !r?.sellExchange) return null;
  const costs=costsForAsset(asset);
  return exchangeFeePct(r.buyExchange,costs)
    + exchangeFeePct(r.sellExchange,costs)
    + (costs.reservePct*2)
    + ((costs.recompositionUsdt/state.budget)*100);
}

function setStatus(exchange,kind,text) {
  const el=$(`${exchange}Status`);
  if (!el) return;
  el.className=`dot ${kind}`;
  el.textContent=text;
}

function touch(exchange,ts) {
  const el=$(`${exchange}Last`);
  if (!el) return;
  el.textContent=ts
    ? `Última cotação: ${new Date(ts).toLocaleTimeString('pt-BR')}`
    : 'Última cotação: —';
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer=null;
}

function applyStatus(exchange,remote) {
  const last=Number(remote?.last)||null;
  touch(exchange,last);
  if (remote?.state==='connected') return setStatus(exchange,'ok','Conectado');
  if (remote?.state==='connecting'||remote?.state==='idle') return setStatus(exchange,'pending','Conectando');
  setStatus(exchange,'bad','Indisponível');
}

function ingestBooks(exchange,incoming={}) {
  const allowed=new Set(state.monitored.map((x)=>x.symbol));
  const target=state.books[exchange];
  for (const [symbol,book] of Object.entries(incoming)) {
    if (!allowed.has(symbol)) continue;
    if (!Array.isArray(book?.bids)||!Array.isArray(book?.asks)||!Number.isFinite(Number(book?.ts))) continue;
    target.set(symbol,{bids:book.bids,asks:book.asks,ts:Number(book.ts)});
  }
}

async function fetchMarket() {
  const r=await fetch('/api/market',{cache:'no-store'});
  if (!r.ok) throw new Error(`Mercado HTTP ${r.status}`);
  const data=await r.json();

  for (const exchange of EXCHANGES) {
    ingestBooks(exchange,data?.books?.[exchange]);
    applyStatus(exchange,data?.status?.[exchange]);
  }
  render();
}

async function startPolling() {
  await fetchMarket();
  state.pollTimer=setInterval(()=>{
    fetchMarket().catch((error)=>console.warn('Falha ao atualizar mercado:',error));
  },1000);
}

async function bootstrap() {
  stopPolling();
  for (const exchange of EXCHANGES) {
    state.books[exchange].clear();
    setStatus(exchange,'pending','Conectando');
    touch(exchange,null);
  }

  const r=await fetch('/api/catalog',{cache:'no-store'});
  if (!r.ok) {
    const body=await r.json().catch(()=>null);
    throw new Error(body?.message||`Catálogo HTTP ${r.status}`);
  }

  const data=await r.json();
  state.catalog=data.candidates||[];
  const bySymbol=new Map(state.catalog.map((x)=>[x.symbol,x]));
  const runtimeSymbols=Array.isArray(data.monitoredSymbols)?data.monitoredSymbols:[];
  state.monitored=runtimeSymbols.map((symbol)=>bySymbol.get(symbol)).filter(Boolean);

  $('identity').textContent=`${state.monitored.length} sondados`;
  $('summary').textContent=`${state.monitored.length} pares USDT sendo sondados em até 5 exchanges`;

  if (!state.monitored.length) throw new Error('Nenhum par spot USDT encontrado nos catálogos públicos.');
  await startPolling();
}

function booksForSymbol(symbol) {
  return Object.fromEntries(
    EXCHANGES
      .map((exchange)=>[exchange,state.books[exchange].get(symbol)])
      .filter(([,book])=>book)
  );
}

function currentResults() {
  const now=Date.now();
  return state.monitored.map((asset)=>evaluateAcrossExchanges({
    symbol:asset.symbol,
    identityConfirmed:asset.identityConfirmed,
    booksByExchange:booksForSymbol(asset.symbol),
    budgetUsdt:state.budget,
    costs:costsForAsset(asset),
    rules:DEFAULT_RULES,
    now,
  }));
}

function render() {
  const results=currentResults();
  const positives=topPositive(results,5);
  const finite=results.filter((r)=>Number.isFinite(r?.netPnlUsdt));
  const live2Plus=state.monitored.filter((asset)=>
    EXCHANGES.filter((exchange)=>state.books[exchange].has(asset.symbol)).length>=2
  ).length;
  const nearest=[...finite]
    .sort((a,b)=>(b.netPnlUsdt??-Infinity)-(a.netPnlUsdt??-Infinity))
    .slice(0,5);

  $('identity').textContent=`${live2Plus} comparáveis`;
  $('summary').textContent=
    `${state.monitored.length} sondados · ${live2Plus} com cotação em 2+ casas · ${finite.length} com liquidez p/ ${state.budget.toLocaleString('pt-BR')} USDT · ${positives.length} elegíveis`;
  $('breakEven').textContent='O breakeven varia conforme a direção porque cada exchange tem sua própria taxa.';

  const best=positives[0];
  const bestObserved=nearest[0];

  if (best) {
    const grossPct=spreadPct(best);
    const breakEven=routeBreakEvenPct(best,state.catalog.find((x)=>x.symbol===best.symbol));
    $('bestLabel').textContent='MELHOR OPORTUNIDADE ELEGÍVEL';
    $('best').innerHTML=`
      <h2>${best.symbol} <span class="profit">${money(best.netPnlUsdt)}</span></h2>
      <div class="heroRoute">${directionLabel(best)}</div>
      <div class="heroMetrics">
        <span><small>Spread bruto</small><b class="pos">+${fmt(grossPct,3)}%</b></span>
        <span><small>Líquido</small><b class="pos">${money(best.netPnlUsdt)}</b></span>
        <span><small>Breakeven rota</small><b>${fmt(breakEven,3)}%</b></span>
      </div>
      <p>Comprar em ${exchangeLabel(best.buyExchange)} @ ${fmt(best.buyVwap,8)} · vender em ${exchangeLabel(best.sellExchange)} @ ${fmt(best.sellVwap,8)} · ROI capital ${fmt(best.roiOnTotalCapitalPct,3)}%.</p>`;
  } else if (bestObserved) {
    const grossPct=spreadPct(bestObserved);
    const breakEven=routeBreakEvenPct(bestObserved,state.catalog.find((x)=>x.symbol===bestObserved.symbol));
    const gapPct=Math.max(0,breakEven-grossPct);
    $('bestLabel').textContent='MELHOR CANDIDATA AGORA';
    $('best').innerHTML=`
      <h2>${bestObserved.symbol}</h2>
      <div class="heroRoute">${directionLabel(bestObserved)}</div>
      <div class="heroMetrics">
        <span><small>Spread bruto</small><b>${grossPct>=0?'+':''}${fmt(grossPct,3)}%</b></span>
        <span><small>Líquido</small><b class="neg">${money(bestObserved.netPnlUsdt)}</b></span>
        <span><small>Falta p/ breakeven</small><b>${fmt(gapPct,3)} p.p.</b></span>
      </div>
      <p>Breakeven desta rota: ${fmt(breakEven,3)}%. Comprar em ${exchangeLabel(bestObserved.buyExchange)} @ ${fmt(bestObserved.buyVwap,8)} · vender em ${exchangeLabel(bestObserved.sellExchange)} @ ${fmt(bestObserved.sellVwap,8)}.</p>`;
  } else {
    $('bestLabel').textContent='MELHOR CANDIDATA AGORA';
    $('best').innerHTML='<h2>—</h2><p>Aguardando pares com cotação recente e liquidez suficiente em pelo menos duas exchanges.</p>';
  }

  const shown=positives.length?positives:nearest;
  $('tableTitle').textContent=positives.length?'Top 5 oportunidades elegíveis':'5 mais próximas do breakeven';
  $('rows').innerHTML=shown.length
    ? shown.map((r)=>{
        const cls=r.eligible?'pos':'neg';
        const status=r.eligible?'elegível':'abaixo do breakeven';
        const grossPct=spreadPct(r);
        const breakEven=routeBreakEvenPct(r,state.catalog.find((x)=>x.symbol===r.symbol));
        return `<tr>
          <td><b>${r.symbol}</b></td>
          <td><b class="routeText">${directionLabel(r)}</b><small class="priceLine">Compra ${fmt(r.buyVwap,8)} · Venda ${fmt(r.sellVwap,8)}</small></td>
          <td class="${grossPct>=breakEven?'pos':''}">${grossPct>=0?'+':''}${fmt(grossPct,3)}%</td>
          <td class="${cls}">${money(r.netPnlUsdt)}</td>
          <td>${status}</td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="5">Nenhum par com dados e liquidez completos neste instante.</td></tr>';
}

for (const btn of document.querySelectorAll('[data-budget]')) {
  btn.addEventListener('click',()=>{
    document.querySelectorAll('[data-budget]').forEach((x)=>x.classList.remove('active'));
    btn.classList.add('active');
    state.budget=Number(btn.dataset.budget);
    $('budgetLabel').textContent=state.budget.toLocaleString('pt-BR');
    $('capital').textContent=(state.budget*2).toLocaleString('pt-BR');
    render();
  });
}

$('reconnect').addEventListener('click',async()=>{
  try { await fetch('/api/reconnect',{method:'POST'}); } catch {}
  bootstrap().catch(showFatal);
});

function showFatal(error) {
  stopPolling();
  $('summary').textContent=`Falha segura: ${error.message}`;
  for (const exchange of EXCHANGES) setStatus(exchange,'bad','Indisponível');
}

bootstrap().catch(showFatal);
