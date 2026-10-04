const EXCHANGES=['binance','bybit','okx','gate','kucoin'];

const state={
  budget:100,
  pollTimer:null,
  lastRadar:null,
  dexTimer:null,
  dexBusy:false,
  lastDexRadar:null,
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
  if (state.dexTimer) clearInterval(state.dexTimer);
  state.pollTimer=null;
  state.dexTimer=null;
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

function shortAddress(address) {
  const value=String(address||'');
  return value.length>12 ? `${value.slice(0,6)}…${value.slice(-4)}` : value || '—';
}

function dexVenueLabel(name) {
  return exchangeLabel(name) !== name ? exchangeLabel(name) : (name || 'DEX');
}

function renderDexRadar(data) {
  state.lastDexRadar=data;
  const positives=Array.isArray(data?.top5)?data.top5:[];
  const nearest=Array.isArray(data?.nearest5)?data.nearest5:[];
  const preliminary=Array.isArray(data?.preliminaryTop5)?data.preliminaryTop5:[];
  const shown=positives.length?positives:(nearest.length?nearest:preliminary);
  const best=shown[0]||null;

  $('dexSummary').textContent=
    `${Number(data?.registryAssets||0).toLocaleString('pt-BR')} identidades (`+
    `${Number(data?.manualRegistryAssets||0)} fixas + ${Number(data?.autoVerifiedAssets||0)} auto-verificadas) · `+
    `${Number(data?.poolsFound||0).toLocaleString('pt-BR')} pools líquidos · `+
    `${Number(data?.confirmedCount||0).toLocaleString('pt-BR')} confirmadas · `+
    `${Number(data?.positiveCount||0)} elegíveis`;

  const funnel=data?.funnel||{};
  const reasons=funnel?.dropReasons||{};
  const funnelEl=$('dexFunnel');
  if (funnelEl) {
    const steps=[
      ['Identidades',funnel.identities],
      ['Ativos c/ pool',funnel.withLiquidPool],
      ['Pools varridos',funnel.selectedPools],
      ['CEX comparável',funnel.cexComparable],
      ['Spread ≥ 0,25%',funnel.preliminaryRoutes],
      ['Forte ≥ 0,50%',funnel.strongRoutes],
      ['Confirmadas',funnel.confirmedRoutes],
      ['Líquido +',funnel.economicsPositiveRoutes],
    ];
    const reasonText=[
      reasons.noLiquidPool?`${reasons.noLiquidPool} sem pool de referência confiável`:null,
      reasons.noCexBook?`${reasons.noCexBook} sem book CEX`:null,
      reasons.spreadBelowPreliminary?`${reasons.spreadBelowPreliminary} sem spread mínimo`:null,
      reasons.belowConfirmationThreshold?`${reasons.belowConfirmationThreshold} abaixo de 0,50%`:null,
      reasons.noQuoteAdapter?`${reasons.noQuoteAdapter} sem quote compatível`:null,
      reasons.waitingConfirmationBudget?`${reasons.waitingConfirmationBudget} aguardando confirmação`:null,
      reasons.confirmationError?`${reasons.confirmationError} erro de confirmação`:null,
      reasons.nonPositiveAfterCosts?`${reasons.nonPositiveAfterCosts} negativas após custos`:null,
      reasons.knownNetworkRestriction?`${reasons.knownNetworkRestriction} com rede restrita`:null,
      reasons.rebalanceUnverified?`${reasons.rebalanceUnverified} rebalance não verificável`:null,
    ].filter(Boolean).join(' · ');

    const coverage=Object.values(data?.coverageByChain||{})
      .filter((x)=>Number(x?.identities||0)>0)
      .map((x)=>`${x.name}: ${Number(x.identities||0)} ativos / ${Number(x.pools||0)} pools / ${Number(x.preliminary||0)} sinais`)
      .join(' · ');
    funnelEl.innerHTML=`<div class="funnelSteps">${steps.map(([label,value],i)=>
      `<div class="funnelStep"><small>${label}</small><b>${Number(value||0).toLocaleString('pt-BR')}</b></div>${i<steps.length-1?'<span class="funnelArrow">→</span>':''}`
    ).join('')}</div><div class="funnelReasons">${reasonText||'Nenhum descarte relevante neste ciclo.'}${coverage?`<br><b>Cobertura:</b> ${coverage}`:''}</div>`;
  }
  $('dexTableTitle').textContent=positives.length
    ? 'Top DEX ↔ CEX confirmadas'
    : (nearest.length ? 'DEX ↔ CEX confirmadas mais próximas' : 'Pré-candidatas DEX ↔ CEX — aguardando quote');

  if (best) {
    const direction=`${dexVenueLabel(best.buyVenue)} → ${dexVenueLabel(best.sellVenue)}`;
    const confirmed=best.confirmedExecutable !== false && Number.isFinite(Number(best.netPnlUsdt));
    const spread=confirmed ? Number(best.grossSpreadPct) : Number(best.preliminarySpreadPct);

    $('dexBest').innerHTML=`
      <h2>${best.asset} ${confirmed?`<span class="${best.eligible?'profit':''}">${money(best.netPnlUsdt)}</span>`:'<span class="neg">NÃO CONFIRMADA</span>'}</h2>
      <div class="heroRoute">${direction}</div>
      <div class="heroMetrics">
        <span><small>${confirmed?'Spread confirmado':'Spread indicativo'}</small><b class="${best.eligible?'pos':''}">${spread>=0?'+':''}${fmt(spread,3)}%</b></span>
        <span><small>Máx. lucrativo agora</small><b>${confirmed&&Number.isFinite(Number(best.maxProfitableBudgetUsdt))?`${fmt(best.maxProfitableBudgetUsdt,2)} USDT`:'—'}</b></span>
        <span><small>Depth CEX</small><b>${best.depthConfirmed?`${best.cexDepthLevels||0} níveis ✓`:'—'}</b></span>
        <span><small>Confirmação DEX</small><b>${confirmed?(best.quoteSource==='direct_onchain'?'direta on-chain ✓':(best.quoteSource==='lifi_fallback'?'LI.FI fallback':'confirmada')):(best.quoteAdapter||'aguardando')}</b></span>
        <span><small>Rede</small><b>${best.chain}</b></span>
        <span><small>Contrato DEX</small><b>${shortAddress(best.contract)}</b></span>
        <span><small>Token na CEX</small><b>${best.cexContractVerified===true?'match exato ✓':(best.cexContractVerified===false?'DIVERGENTE':'não público')}</b></span>
        <span><small>USDT na CEX</small><b>${best.quoteContractVerified===true?'match exato ✓':(best.quoteContractVerified===false?'DIVERGENTE':'não público')}</b></span>
        <span><small>Rebalance</small><b>${best.rebalanceStatus==='verified_open'?'2 pernas ✓':(best.rebalanceStatus==='restricted'?'RESTRITA':'não verificado')}</b></span>
        <span><small>Gas estimado</small><b>${confirmed?money(-Number(best.gasUsd||0)):'—'}</b></span>
        <span><small>Liquidez pool</small><b>${Number(best.poolLiquidityUsd||0).toLocaleString('pt-BR',{style:'currency',currency:'USD',maximumFractionDigits:0})}</b></span>
      </div>
      <p>Identidade DEX: chainId ${best.chainId} + contrato exato. Mapeamentos automáticos só entram após concordância do contrato entre lista oficial Uniswap e LI.FI; nenhum token arbitrário é aceito apenas pelo ticker. ${confirmed?`Quote: ${best.quoteSourceLabel||best.quoteSource||'confirmado'}. Screening: ${best.screeningStatus}. Order book da CEX confirmado em múltiplos níveis.`:'Quote executável ainda não confirmado — não usar esta linha para executar.'} ${best.knownNetworkRestriction?'Uma das pernas necessárias ao rebalanceamento token/USDT está publicamente restrita ou divergente e a rota foi bloqueada.':(best.transferabilityVerified?'As duas pernas direcionais do rebalanceamento foram verificadas publicamente na mesma rede e com contratos compatíveis.':'Quando a CEX não expõe todos os dados públicos de token e USDT, o radar mantém o rebalanceamento como não verificado, sem fingir garantia.')} A execução continua em modo read-only.</p>`;
  } else {
    $('dexBest').innerHTML='<h2>—</h2><p>Nenhuma rota DEX ↔ CEX detectada neste ciclo. O radar só aceita contrato exato; ticker sozinho nunca é usado como identidade.</p>';
  }

  $('dexRows').innerHTML=shown.length
    ? shown.map((r)=>{
        const confirmed=r.confirmedExecutable !== false && Number.isFinite(Number(r.netPnlUsdt));
        const spread=confirmed ? Number(r.grossSpreadPct) : Number(r.preliminarySpreadPct);
        return `<tr>
        <td><b>${r.asset}</b><small class="priceLine">${r.chain} · ${shortAddress(r.contract)}</small></td>
        <td><b class="routeText">${dexVenueLabel(r.buyVenue)} → ${dexVenueLabel(r.sellVenue)}</b><small class="priceLine">DEX: ${r.dex}</small></td>
        <td class="${r.eligible?'pos':''}">${spread>=0?'+':''}${fmt(spread,3)}%</td>
        <td class="${r.eligible?'pos':'neg'}">${confirmed?money(r.netPnlUsdt):'aguardando quote'}</td>
        <td>${r.sameAssetVerified
          ? (confirmed
              ? `DEX contrato ✓ · token CEX ${r.cexContractVerified===true?'✓':(r.cexContractVerified===false?'≠':'?')} · USDT CEX ${r.quoteContractVerified===true?'✓':(r.quoteContractVerified===false?'≠':'?')} · depth ${r.depthConfirmed?'✓':'—'} · ${r.rebalanceStatus==='verified_open'?'rebalance 2/2 ✓':(r.rebalanceStatus==='restricted'?'rebalance restrito':'rebalance ?')}`
              : 'DEX contrato ✓ · CEX ainda não confirmada')
          : 'bloqueado'}</td>
      </tr>`;
      }).join('')
    : '<tr><td colspan="5">Nenhuma rota DEX ↔ CEX detectada neste ciclo.</td></tr>';
}

async function fetchDexRadar() {
  if (state.dexBusy) return;
  state.dexBusy=true;
  try {
    const r=await fetch(`/api/dex-radar?budget=${encodeURIComponent(state.budget)}`,{cache:'no-store'});
    if (!r.ok) {
      const body=await r.json().catch(()=>null);
      throw new Error(body?.message||`DEX radar HTTP ${r.status}`);
    }
    renderDexRadar(await r.json());
  } catch(error) {
    $('dexSummary').textContent=`DEX beta: ${error.message}`;
  } finally {
    state.dexBusy=false;
  }
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
  await fetchDexRadar();
  state.dexTimer=setInterval(fetchDexRadar,15_000);
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
    fetchDexRadar();
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
