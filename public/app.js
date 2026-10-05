const EXCHANGES=['binance','bybit','okx','gate','kucoin','bitget','htx'];

const state={
  budget:100,
  pollTimer:null,
  dexTimer:null,
  dexBusy:false,
  lastRadar:null,
  lastDexRadar:null,
  selectedRouteKey:null,
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
  bitget:'Bitget',
  htx:'HTX',
}[name]||name||'—');

const directionLabel=(r)=>r?.buyExchange&&r?.sellExchange
  ? `${exchangeLabel(r.buyExchange)} → ${exchangeLabel(r.sellExchange)}`
  : '—';

const routeKey=(r)=>r
  ? `${r.symbol||''}|${r.buyExchange||''}|${r.sellExchange||''}`
  : '';

function setStatus(exchange,kind,text){
  const el=$(`${exchange}Status`);
  if(!el) return;
  el.className=`dot ${kind}`;
  el.textContent=text;
}

function touch(exchange,ts){
  const el=$(`${exchange}Last`);
  if(!el) return;
  el.textContent=ts
    ? `Última cotação: ${new Date(Number(ts)).toLocaleTimeString('pt-BR')}`
    : 'Última cotação: —';
}

function applyStatus(exchange,remote){
  const last=Number(remote?.last)||null;
  touch(exchange,last);
  if(remote?.state==='connected'){
    setStatus(exchange,'ok','Online');
    return true;
  }
  if(remote?.state==='connecting'||remote?.state==='idle'){
    setStatus(exchange,'pending','Conectando');
    return false;
  }
  setStatus(exchange,'bad','Offline');
  return false;
}

function stopPolling(){
  if(state.pollTimer) clearInterval(state.pollTimer);
  if(state.dexTimer) clearInterval(state.dexTimer);
  state.pollTimer=null;
  state.dexTimer=null;
}

function priceDigits(value){
  const n=Number(value);
  if(!Number.isFinite(n)||n<=0) return 4;
  if(n>=1000) return 2;
  if(n>=10) return 3;
  if(n>=1) return 4;
  if(n>=0.01) return 6;
  return 8;
}

function rankingFor(data){
  const confirmed=Array.isArray(data?.top5)?data.top5:[];
  const signals=Array.isArray(data?.signals)?data.signals:[];
  const nearest=Array.isArray(data?.nearest5)?data.nearest5:[];
  const rows=confirmed.length?confirmed:(signals.length?signals:nearest);
  return {
    positives:confirmed,
    signals,
    nearest,
    rows:rows.slice(0,5),
    isPositive:confirmed.length>0,
    mode:confirmed.length?'confirmed':(signals.length?'signals':'nearest'),
  };
}

function realityLabel(route){
  if(route?.realityStatus==='confirmed') return `CONFIRMADA · ${Number(route?.confidenceScore||0)}%`;
  const streak=Number(route?.confirmationStreak||0);
  const required=Number(route?.confirmationsRequired||3);
  if(route?.realityStatus==='checking') return 'CHECANDO DEPTH';
  if(route?.realityStatus==='error') return 'FALHA NA CONFIRMAÇÃO';
  if(route?.realityStatus==='rejected') return 'DEPTH REJEITOU';
  return `CONFIRMANDO ${streak}/${required}`;
}

function renderExchangeHealth(data){
  let connected=0;
  for(const exchange of EXCHANGES){
    if(applyStatus(exchange,data?.status?.[exchange])) connected+=1;
  }

  const health=$('systemHealth');
  health.className=`healthPill ${connected===EXCHANGES.length?'ok':connected===0?'bad':'pending'}`;
  health.querySelector('span').textContent=`${connected}/${EXCHANGES.length} online`;
  $('exchangeSummary').textContent=`${connected} de ${EXCHANGES.length} fontes online`;
}

function renderTop5(data){
  const {rows,isPositive}=rankingFor(data);
  $('top5Title').textContent=isPositive?'TOP 5 CONFIRMADAS':(Array.isArray(data?.signals)&&data.signals.length?'SINAIS EM CONFIRMAÇÃO':'5 MAIS PRÓXIMAS');
  $('top5Updated').textContent=`${new Date().toLocaleTimeString('pt-BR')} · ${Number(data?.confirmedCount||0)} confirmadas · ${Number(data?.positiveNet||0)} sinais +`;

  if(rows.length && !rows.some((r)=>routeKey(r)===state.selectedRouteKey)){
    state.selectedRouteKey=routeKey(rows[0]);
  }

  $('top5List').innerHTML=rows.length
    ? rows.map((r,index)=>{
        const eligible=Boolean(r?.eligible);
        const selected=routeKey(r)===state.selectedRouteKey;
        const executable=Number(r?.executableBudgetUsdt||r?.budgetUsdt||0);
        const spread=Number(r?.grossSpreadPct);
        const pnl=Number(r?.netPnlUsdt);
        return `<button type="button" class="opRow ${selected?'selected':''} ${eligible?'':'near'}" data-route-key="${routeKey(r)}">
          <span class="rank">#${index+1}</span>
          <span class="opSymbol">${r.symbol||'—'}</span>
          <span class="opRoute">
            <strong>${directionLabel(r)}</strong>
            <small>${realityLabel(r)} · ${spread>=0?'+':''}${fmt(spread,3)}% · até ${fmt(executable,0)} USDT</small>
          </span>
          <span class="opProfit">
            <b>${Number.isFinite(pnl)?`${pnl>=0?'+':''}${fmt(pnl,2)}`:'—'}</b>
            <small>USDT</small>
          </span>
        </button>`;
      }).join('')
    : '<div class="emptyState">Nenhuma rota completa neste instante. O radar continua atualizando.</div>';

  document.querySelectorAll('[data-route-key]').forEach((button)=>{
    button.addEventListener('click',()=>{
      state.selectedRouteKey=button.dataset.routeKey;
      renderTop5(state.lastRadar);
      renderFocusedOpportunity(state.lastRadar);
    });
  });
}

function orderedVenueQuotes(result){
  const quotes=Array.isArray(result?.venueQuotes)?result.venueQuotes:[];
  if(!quotes.length) return [];
  const chosen=[result?.buyExchange,result?.sellExchange].filter(Boolean);
  return [...quotes].sort((a,b)=>{
    const ai=chosen.indexOf(a.exchange);
    const bi=chosen.indexOf(b.exchange);
    const ar=ai===-1?99:ai;
    const br=bi===-1?99:bi;
    if(ar!==br) return ar-br;
    return EXCHANGES.indexOf(a.exchange)-EXCHANGES.indexOf(b.exchange);
  });
}

function venuePriceRail(result){
  const quotes=orderedVenueQuotes(result);
  if(!quotes.length) return '<div class="emptyState">Sem cotações adicionais recentes.</div>';

  return `<div class="priceRail">${quotes.map((q)=>{
    const buy=q.exchange===result?.buyExchange;
    const sell=q.exchange===result?.sellExchange;
    const tag=buy?'COMPRAR':sell?'VENDER':'';
    const cls=buy?'buy':sell?'sell':'';
    return `<div class="venueCard ${cls}">
      <div class="venueHead">
        <b>${exchangeLabel(q.exchange)}</b>
        <em>${tag||'REFERÊNCIA'}</em>
      </div>
      <strong>${fmt(q.mid,priceDigits(q.mid))}</strong>
      <small>ask ${fmt(q.ask,priceDigits(q.ask))}</small>
      <small>bid ${fmt(q.bid,priceDigits(q.bid))}</small>
    </div>`;
  }).join('')}</div>`;
}

function renderFocusedOpportunity(data){
  const {rows,mode}=rankingFor(data);
  const selected=rows.find((r)=>routeKey(r)===state.selectedRouteKey)||rows[0]||null;

  if(!selected){
    $('focusCard').innerHTML=`<div class="focusLoading">
      <strong>Nenhuma oportunidade completa agora</strong>
      <span>O Top 5 continua atualizando automaticamente.</span>
    </div>`;
    return;
  }

  const confirmed=selected?.realityStatus==='confirmed';
  const eligible=Boolean(selected?.eligible);
  const pnl=Number(selected?.netPnlUsdt);
  const spread=Number(selected?.grossSpreadPct);
  const breakEven=Number(selected?.breakEvenPct);
  const roi=Number(selected?.roiOnTotalCapitalPct);
  const requested=Number(selected?.requestedBudgetUsdt||state.budget);
  const executable=Number(selected?.executableBudgetUsdt||selected?.budgetUsdt||0);
  const share=requested>0?Math.max(0,Math.min(100,(executable/requested)*100)):0;
  const afterRebalance=Number(selected?.netAfterRebalanceUsdt);
  const gap=Number.isFinite(spread)&&Number.isFinite(breakEven)?Math.max(0,breakEven-spread):null;

  $('focusCard').innerHTML=`
    <div class="focusHero">
      <div class="focusPair">
        <span>${confirmed?'OPORTUNIDADE CONFIRMADA':(mode==='signals'?'SINAL EM CONFIRMAÇÃO':'CANDIDATA MAIS PRÓXIMA')}</span>
        <h1>${selected.symbol}</h1>
      </div>
      <div class="focusPnl">
        <small>${confirmed?'líquido confirmado':'líquido indicativo'}</small>
        <strong class="${confirmed?'':'near'}">${money(pnl)}</strong>
      </div>
    </div>

    <div class="routeTicket">
      <div class="legCard buy">
        <div class="legLabel"><span>COMPRAR</span><b>${exchangeLabel(selected.buyExchange)}</b></div>
        <div class="legPrice">${fmt(selected.buyVwap,priceDigits(selected.buyVwap))}</div>
        <small>ask / VWAP de entrada</small>
      </div>
      <div class="routeArrow">→</div>
      <div class="legCard sell">
        <div class="legLabel"><span>VENDER</span><b>${exchangeLabel(selected.sellExchange)}</b></div>
        <div class="legPrice">${fmt(selected.sellVwap,priceDigits(selected.sellVwap))}</div>
        <small>bid / VWAP de saída</small>
      </div>
    </div>

    <div class="metricGrid">
      <div class="metric">
        <small>Spread bruto</small>
        <b class="${eligible?'good':''}">${spread>=0?'+':''}${fmt(spread,3)}%</b>
      </div>
      <div class="metric">
        <small>ROI capital total</small>
        <b>${Number.isFinite(roi)?`${roi>=0?'+':''}${fmt(roi,3)}%`:'—'}</b>
      </div>
      <div class="metric">
        <small>${eligible?'Breakeven':'Falta p/ breakeven'}</small>
        <b>${eligible?`${fmt(breakEven,3)}%`:`${fmt(gap,3)} p.p.`}</b>
      </div>
    </div>

    <div class="capacityBar">
      <div class="capacityTop">
        <span>Executável agora: <b>${fmt(executable,2)} USDT</b></span>
        <span>${fmt(share,0)}% do teto de ${fmt(requested,0)}</span>
      </div>
      <div class="barTrack"><div class="barFill" style="width:${share}%"></div></div>
    </div>

    <div class="realityStrip">
      <span class="${confirmed?'verified':'checking'}">${realityLabel(selected)}</span>
      <span>Depth ${Number(selected?.buyDepthLevels||0)}×${Number(selected?.sellDepthLevels||0)}</span>
      <span>Saldo pré-posicionado</span>
      <span>Fill não garantido</span>
    </div>

    <div class="tradeHint ${confirmed?'verifiedHint':'warningHint'}">
      <i>●</i>
      <span>${confirmed
        ? `Depth multi-level reconfirmado ${Number(selected?.confirmationStreak||0)}/${Number(selected?.confirmationsRequired||3)}. Comprar em <b>${exchangeLabel(selected.buyExchange)}</b> e vender em <b>${exchangeLabel(selected.sellExchange)}</b>. Pós-recomposição estimado: <b>${money(afterRebalance)}</b>. A oportunidade pode mudar antes do fill.`
        : `Este é apenas um sinal do broad scan. O Reality Gate ainda não terminou a confirmação de depth/persistência. <b>Não executar como confirmado.</b>`}</span>
    </div>

    <details class="priceDisclosure">
      <summary>Comparar preço nas corretoras</summary>
      ${venuePriceRail(selected)}
    </details>
  `;
}

function renderAudit(data){
  const {rows}=rankingFor(data);
  $('top5Audit').innerHTML=rows.length
    ? rows.map((r,index)=>`<div class="auditRow">
        <span>#${index+1}</span>
        <b>${r.symbol}</b>
        <small>${directionLabel(r)} · ${realityLabel(r)} · ${fmt(r.grossSpreadPct,3)}%</small>
        <strong>${money(r.netPnlUsdt)}</strong>
      </div>`).join('')
    : '<div class="emptyState">Sem rotas completas para auditar agora.</div>';
}

function renderRadar(data){
  state.lastRadar=data;
  renderExchangeHealth(data);

  $('comparables').textContent=`${Number(data?.pairsWith2PlusVenues||0).toLocaleString('pt-BR')} pares comparáveis`;
  $('radarSummary').textContent=
    `${Number(data?.monitored||0).toLocaleString('pt-BR')} monitorados · `+
    `${Number(data?.liquidResults||0).toLocaleString('pt-BR')} avaliáveis · `+
    `${Number(data?.confirmedCount||0)} confirmadas · `+
    `${Number(data?.positiveNet||0)} sinais positivos`;

  renderTop5(data);
  renderFocusedOpportunity(data);
  renderAudit(data);
}

function shortAddress(address){
  const value=String(address||'');
  return value.length>12?`${value.slice(0,6)}…${value.slice(-4)}`:value||'—';
}

function dexVenueLabel(name){
  return exchangeLabel(name)!==name?exchangeLabel(name):(name||'DEX');
}

function renderDexRadar(data){
  state.lastDexRadar=data;
  const positives=Array.isArray(data?.top5)?data.top5:[];
  const nearest=Array.isArray(data?.nearest5)?data.nearest5:[];
  const preliminary=Array.isArray(data?.preliminaryTop5)?data.preliminaryTop5:[];
  const rows=positives.length?positives:(nearest.length?nearest:preliminary);
  const best=rows[0]||null;

  $('dexSummary').textContent=
    `${Number(data?.registryAssets||0)} identidades · `+
    `${Number(data?.poolsFound||0)} pools · `+
    `${Number(data?.confirmedCount||0)} confirmadas · `+
    `${Number(data?.positiveCount||0)} elegíveis`;

  const funnel=data?.funnel||{};
  const reasons=funnel?.dropReasons||{};
  const steps=[
    ['Identidades',funnel.identities],
    ['Com pool',funnel.withLiquidPool],
    ['CEX ok',funnel.cexComparable],
    ['Sinais',funnel.preliminaryRoutes],
    ['Fortes',funnel.strongRoutes],
    ['Confirmadas',funnel.confirmedRoutes],
    ['Líquido +',funnel.economicsPositiveRoutes],
  ];
  const reasonText=[
    reasons.noLiquidPool?`${reasons.noLiquidPool} sem pool confiável`:null,
    reasons.noCexBook?`${reasons.noCexBook} sem book CEX`:null,
    reasons.nonPositiveAfterCosts?`${reasons.nonPositiveAfterCosts} negativas após custos`:null,
    reasons.knownNetworkRestriction?`${reasons.knownNetworkRestriction} com rede restrita`:null,
  ].filter(Boolean).join(' · ');

  $('dexFunnel').innerHTML=`
    <div class="funnelSteps">${steps.map(([label,value],i)=>
      `<div class="funnelStep"><small>${label}</small><b>${Number(value||0).toLocaleString('pt-BR')}</b></div>${i<steps.length-1?'<span class="funnelArrow">→</span>':''}`
    ).join('')}</div>
    <div class="funnelReasons">${reasonText||'Nenhum descarte relevante neste ciclo.'}</div>
  `;

  if(best){
    const confirmed=best.confirmedExecutable!==false&&Number.isFinite(Number(best.netPnlUsdt));
    const spread=confirmed?Number(best.grossSpreadPct):Number(best.preliminarySpreadPct);
    $('dexBest').innerHTML=`
      <div class="dexHeroTop">
        <div>
          <small>${best.chain||'chain'} · ${shortAddress(best.contract)}</small>
          <h3>${best.asset}</h3>
        </div>
        <strong class="${best.eligible?'':'near'}">${confirmed?money(best.netPnlUsdt):'não confirmada'}</strong>
      </div>
      <div class="dexRoute">${dexVenueLabel(best.buyVenue)} → ${dexVenueLabel(best.sellVenue)}</div>
      <div class="dexMetrics">
        <div><small>Spread</small><b>${spread>=0?'+':''}${fmt(spread,3)}%</b></div>
        <div><small>Depth CEX</small><b>${best.depthConfirmed?`${best.cexDepthLevels||0} níveis ✓`:'—'}</b></div>
        <div><small>Quote</small><b>${confirmed?(best.quoteSource==='direct_onchain'?'on-chain ✓':best.quoteSource||'confirmado'):'aguardando'}</b></div>
        <div><small>Rebalance</small><b>${best.rebalanceStatus==='verified_open'?'2/2 ✓':best.rebalanceStatus==='restricted'?'restrito':'não verificado'}</b></div>
      </div>
    `;
  }else{
    $('dexBest').innerHTML=`<div class="focusLoading">
      <strong>Nenhuma rota DEX ↔ CEX agora</strong>
      <span>O beta continua exigindo contrato, chain, quote e custos confirmados.</span>
    </div>`;
  }

  $('dexList').innerHTML=rows.length
    ? rows.slice(0,5).map((r)=>`<div class="dexRow">
        <div><b>${r.asset}</b><small>${r.chain||'—'}</small></div>
        <div><b>${dexVenueLabel(r.buyVenue)} → ${dexVenueLabel(r.sellVenue)}</b><small>${r.dex||'DEX'} · ${r.confirmedExecutable===false?'aguardando quote':'confirmada'}</small></div>
        <strong class="${r.eligible?'good':''}">${Number.isFinite(Number(r.netPnlUsdt))?money(r.netPnlUsdt):`${fmt(r.preliminarySpreadPct,3)}%`}</strong>
      </div>`).join('')
    : '<div class="emptyState">Nenhuma rota DEX ↔ CEX detectada neste ciclo.</div>';
}

async function fetchRadar(){
  const r=await fetch(`/api/radar?budget=${encodeURIComponent(state.budget)}`,{cache:'no-store'});
  if(!r.ok){
    const body=await r.json().catch(()=>null);
    throw new Error(body?.message||`Radar HTTP ${r.status}`);
  }
  renderRadar(await r.json());
}

async function fetchDexRadar(){
  if(state.dexBusy||!$('dexModule')?.open) return;
  state.dexBusy=true;
  try{
    const r=await fetch(`/api/dex-radar?budget=${encodeURIComponent(state.budget)}`,{cache:'no-store'});
    if(!r.ok){
      const body=await r.json().catch(()=>null);
      throw new Error(body?.message||`DEX radar HTTP ${r.status}`);
    }
    renderDexRadar(await r.json());
  }catch(error){
    $('dexSummary').textContent=`DEX beta: ${error.message}`;
  }finally{
    state.dexBusy=false;
  }
}

function startDexPolling(){
  if(state.dexTimer) clearInterval(state.dexTimer);
  fetchDexRadar();
  state.dexTimer=setInterval(fetchDexRadar,15_000);
}

async function bootstrap(){
  stopPolling();
  for(const exchange of EXCHANGES){
    setStatus(exchange,'pending','Conectando');
    touch(exchange,null);
  }
  $('systemHealth').className='healthPill pending';
  $('systemHealth').querySelector('span').textContent='conectando';
  await fetchRadar();
  state.pollTimer=setInterval(()=>{
    fetchRadar().catch((error)=>console.warn('Falha ao atualizar radar:',error));
  },1000);

  if($('dexModule')?.open) startDexPolling();
}

for(const btn of document.querySelectorAll('[data-budget]')){
  btn.addEventListener('click',()=>{
    document.querySelectorAll('[data-budget]').forEach((x)=>x.classList.remove('active'));
    btn.classList.add('active');
    state.budget=Number(btn.dataset.budget);
    state.selectedRouteKey=null;
    $('budgetLabel').textContent=state.budget.toLocaleString('pt-BR');
    fetchRadar().catch(showFatal);
    if($('dexModule')?.open) fetchDexRadar();
  });
}

$('dexModule')?.addEventListener('toggle',()=>{
  if($('dexModule').open){
    startDexPolling();
  }else if(state.dexTimer){
    clearInterval(state.dexTimer);
    state.dexTimer=null;
  }
});

$('reconnect').addEventListener('click',async()=>{
  try{await fetch('/api/reconnect',{method:'POST'});}catch{}
  bootstrap().catch(showFatal);
});

function showFatal(error){
  stopPolling();
  $('systemHealth').className='healthPill bad';
  $('systemHealth').querySelector('span').textContent='offline';
  $('top5Title').textContent='RADAR INDISPONÍVEL';
  $('top5Updated').textContent='sem atualização';
  $('top5List').innerHTML=`<div class="emptyState">Falha segura: ${error.message}. Use ↻ para reconectar.</div>`;
  $('focusCard').innerHTML='<div class="focusLoading"><strong>Sem dados confiáveis</strong><span>O app não mostra oportunidade enquanto o radar estiver indisponível.</span></div>';
  for(const exchange of EXCHANGES) setStatus(exchange,'bad','Offline');
}

bootstrap().catch(showFatal);
