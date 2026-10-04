const EXCHANGES=['binance','bybit','okx','gate','kucoin'];

const state={
  budget:100,
  pollTimer:null,
  lastRadar:null,
};

const $=(id)=>document.getElementById(id);
const fmt=(n,d=4)=>Number.isFinite(Number(n))
  ? Number(n).toLocaleString('pt-BR',{minimumFractionDigits:d,maximumFractionDigits:d})
  : '—';
const money=(n)=>Number.isFinite(Number(n))
  ? `${Number(n)>=0?'+':''}${fmt(Number(n),2)} USDT`
  : '—';
const exchangeLabel=(name)=>({
  binance:'Binance',
  bybit:'Bybit',
  okx:'OKX',
  gate:'Gate.io',
  kucoin:'KuCoin',
}[name]||name||'—');

const directionLabel=(r)=>r?.buyExchange&&r?.sellExchange
  ? `${exchangeLabel(r.buyExchange)} → ${exchangeLabel(r.sellExchange)}`
  : '—';

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
    ? `Última cotação: ${new Date(Number(ts)).toLocaleTimeString('pt-BR')}`
    : 'Última cotação: —';
}

function applyStatus(exchange,remote) {
  const last=Number(remote?.last)||null;
  touch(exchange,last);
  if (remote?.state==='connected') return setStatus(exchange,'ok','Conectado');
  if (remote?.state==='connecting'||remote?.state==='idle') return setStatus(exchange,'pending','Conectando');
  setStatus(exchange,'bad','Indisponível');
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer=null;
}

function renderRadar(data) {
  state.lastRadar=data;
  for (const exchange of EXCHANGES) applyStatus(exchange,data?.status?.[exchange]);

  $('identity').textContent=`${Number(data?.pairsWith2PlusVenues||0).toLocaleString('pt-BR')} comparáveis`;
  $('summary').textContent=
    `${Number(data?.monitored||0).toLocaleString('pt-BR')} sondados · `+
    `${Number(data?.pairsWith2PlusVenues||0).toLocaleString('pt-BR')} com cotação em 2+ casas · `+
    `${Number(data?.liquidResults||0).toLocaleString('pt-BR')} rotas avaliáveis com até ${state.budget.toLocaleString('pt-BR')} USDT · `+
    `${Number(data?.positiveNet||0)} elegíveis`;

  $('breakEven').textContent='O breakeven varia conforme a direção e as taxas aplicáveis ao par em cada exchange.';

  const positives=Array.isArray(data?.top5)?data.top5:[];
  const nearest=Array.isArray(data?.nearest5)?data.nearest5:[];
  const best=positives[0]||nearest[0]||null;

  if (best) {
    const grossPct=Number(best?.grossSpreadPct);
    const breakEven=Number(best?.breakEvenPct);
    const eligible=Boolean(best?.eligible);

    $('bestLabel').textContent=eligible
      ? 'MELHOR OPORTUNIDADE ELEGÍVEL'
      : 'MELHOR CANDIDATA AGORA';

    const gapPct=Number.isFinite(grossPct)&&Number.isFinite(breakEven)
      ? Math.max(0,breakEven-grossPct)
      : null;

    const requested=Number(best.requestedBudgetUsdt||state.budget);
    const executable=Number(best.executableBudgetUsdt||best.budgetUsdt);
    const limited=Boolean(best.liquidityLimited);

    $('best').innerHTML=`
      <h2>${best.symbol}${eligible?` <span class="profit">${money(best.netPnlUsdt)}</span>`:''}</h2>
      <div class="heroRoute">${directionLabel(best)}</div>
      <div class="heroMetrics">
        <span><small>Valor executável</small><b>${fmt(executable,2)} USDT${limited?` / ${fmt(requested,0)} máx.`:''}</b></span>
        <span><small>Spread bruto</small><b class="${eligible?'pos':''}">${grossPct>=0?'+':''}${fmt(grossPct,3)}%</b></span>
        <span><small>Líquido execução</small><b class="${eligible?'pos':'neg'}">${money(best.netPnlUsdt)}</b></span>
        <span><small>Após recomposição</small><b class="${Number(best.netAfterRebalanceUsdt)>=0?'pos':'neg'}">${money(best.netAfterRebalanceUsdt)}</b></span>
        <span><small>${eligible?'Breakeven execução':'Falta p/ breakeven'}</small><b>${eligible?fmt(breakEven,3)+'%':fmt(gapPct,3)+' p.p.'}</b></span>
      </div>
      <p>Comprar em ${exchangeLabel(best.buyExchange)} @ ${fmt(best.buyVwap,8)} · vender em ${exchangeLabel(best.sellExchange)} @ ${fmt(best.sellVwap,8)} · ROI da execução ${fmt(best.roiOnTotalCapitalPct,3)}%. ${limited?`Com limite de ${fmt(requested,0)} USDT, o book atualmente visível comporta ${fmt(executable,2)} USDT nesta rota.`:'O valor máximo selecionado cabe integralmente no book visível.'} A recomposição é estimada separadamente.</p>`;
  } else {
    $('bestLabel').textContent='MELHOR CANDIDATA AGORA';
    $('best').innerHTML='<h2>—</h2><p>Aguardando pares com cotação recente e liquidez suficiente em pelo menos duas exchanges.</p>';
  }

  const shown=positives.length?positives:nearest;
  $('tableTitle').textContent=positives.length
    ? 'Top 5 oportunidades elegíveis'
    : '5 mais próximas do breakeven';

  $('rows').innerHTML=shown.length
    ? shown.map((r)=>{
        const eligible=Boolean(r?.eligible);
        const grossPct=Number(r?.grossSpreadPct);
        const breakEven=Number(r?.breakEvenPct);
        const cls=eligible?'pos':'neg';
        return `<tr>
          <td><b>${r.symbol}</b></td>
          <td><b class="routeText">${directionLabel(r)}</b><small class="priceLine">Compra ${fmt(r.buyVwap,8)} · Venda ${fmt(r.sellVwap,8)}</small></td>
          <td class="${eligible?'pos':''}">${grossPct>=0?'+':''}${fmt(grossPct,3)}%</td>
          <td class="${cls}">${money(r.netPnlUsdt)}<small class="priceLine">Pós-rebalance ${money(r.netAfterRebalanceUsdt)}</small></td>
          <td>${eligible
            ? (r.liquidityLimited
                ? `elegível até ${fmt(r.executableBudgetUsdt||r.budgetUsdt,2)} USDT`
                : `elegível até ${fmt(r.requestedBudgetUsdt||state.budget,0)} USDT`)
            : `breakeven ${fmt(breakEven,3)}%`}</td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="5">Nenhum par com dados e liquidez completos neste instante.</td></tr>';
}

async function fetchRadar() {
  const r=await fetch(`/api/radar?budget=${encodeURIComponent(state.budget)}`,{cache:'no-store'});
  if (!r.ok) {
    const body=await r.json().catch(()=>null);
    throw new Error(body?.message||`Radar HTTP ${r.status}`);
  }
  renderRadar(await r.json());
}

async function startPolling() {
  await fetchRadar();
  state.pollTimer=setInterval(()=>{
    fetchRadar().catch((error)=>console.warn('Falha ao atualizar radar:',error));
  },1000);
}

async function bootstrap() {
  stopPolling();
  for (const exchange of EXCHANGES) {
    setStatus(exchange,'pending','Conectando');
    touch(exchange,null);
  }
  $('summary').textContent='Inicializando radar multiexchange…';
  await startPolling();
}

for (const btn of document.querySelectorAll('[data-budget]')) {
  btn.addEventListener('click',()=>{
    document.querySelectorAll('[data-budget]').forEach((x)=>x.classList.remove('active'));
    btn.classList.add('active');
    state.budget=Number(btn.dataset.budget);
    $('budgetLabel').textContent=state.budget.toLocaleString('pt-BR');
    $('capital').textContent=(state.budget*2).toLocaleString('pt-BR');
    fetchRadar().catch(showFatal);
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
