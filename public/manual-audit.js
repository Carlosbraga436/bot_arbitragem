import { exchangeTradeUrl } from './exchange-links.js';

const EXCHANGE_LABELS={binance:'Binance',bybit:'Bybit',okx:'OKX',gate:'Gate.io',kucoin:'KuCoin',bitget:'Bitget',htx:'HTX'};

function label(exchange){ return EXCHANGE_LABELS[exchange]||exchange||'—'; }
function fmt(value,digits=4){
  const n=Number(value);
  return Number.isFinite(n)?n.toLocaleString('pt-BR',{minimumFractionDigits:digits,maximumFractionDigits:digits}):'—';
}
function money(value){
  const n=Number(value);
  return Number.isFinite(n)?(n>=0?'+':'')+fmt(n,2)+' USDT':'—';
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
function cloneRoute(route){
  if(!route) return null;
  if(typeof structuredClone==='function') return structuredClone(route);
  return JSON.parse(JSON.stringify(route));
}
function quote(route,exchange){
  return (Array.isArray(route?.venueQuotes)?route.venueQuotes:[]).find((q)=>q?.exchange===exchange)||null;
}
function timeLabel(ts){
  const n=Number(ts);
  return Number.isFinite(n)?new Date(n).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—';
}
function ageLabel(ts,capturedAt){
  const t=Number(ts);
  const cap=Number(capturedAt);
  if(!Number.isFinite(t)||!Number.isFinite(cap)) return '—';
  const age=Math.max(0,cap-t);
  return age<1000?Math.round(age)+' ms':(age/1000).toLocaleString('pt-BR',{minimumFractionDigits:1,maximumFractionDigits:1})+' s';
}
function realityLabel(route){
  if(route?.operationalOk) return 'OPERACIONAL OK';
  if(route?.realityStatus==='confirmed') return 'DEPTH OK · '+Number(route?.confidenceScore||0)+'/100';
  const streak=Number(route?.confirmationStreak||0);
  const required=Number(route?.confirmationsRequired||3);
  if(route?.realityStatus==='checking') return 'CHECANDO DEPTH';
  if(route?.realityStatus==='error') return 'FALHA NA CONFIRMAÇÃO';
  if(route?.realityStatus==='rejected') return 'DEPTH REJEITOU';
  return 'CONFIRMANDO '+streak+'/'+required;
}
function numberOrDash(value,digits=8){ return Number.isFinite(Number(value))?fmt(Number(value),digits):'—'; }
function ruleValue(value){ return value===null||value===undefined||value===''?'—':String(value); }

export function createManualAuditController({getSelectedRoute}){
  let snapshot=null;
  let capturedAt=null;
  const root=document.getElementById('manualAudit');
  const body=document.getElementById('manualAuditBody');
  const title=document.getElementById('manualAuditTitle');
  const time=document.getElementById('manualAuditTime');
  const copyBtn=document.getElementById('manualAuditCopy');

  function legHtml(route,side){
    const buy=side==='buy';
    const exchange=buy?route?.buyExchange:route?.sellExchange;
    const q=quote(route,exchange);
    const plan=route?.operationalPlan||{};
    const rules=buy?plan?.buyRules:plan?.sellRules;
    const observed=buy?q?.ask:q?.bid;
    const topQty=buy?q?.askQty:q?.bidQty;
    const vwap=buy?route?.buyVwap:route?.sellVwap;
    const limit=buy?plan?.buyLimitPrice:plan?.sellLimitPrice;
    const url=exchangeTradeUrl(exchange,route?.symbol);
    return [
      '<section class="manualLeg '+(buy?'buy':'sell')+'">',
      '<div class="manualLegHead"><div><span>'+(buy?'COMPRAR':'VENDER')+'</span><b>'+label(exchange)+'</b></div>',
      url?'<a href="'+url+'" target="_blank" rel="noopener noreferrer">Abrir '+label(exchange)+' ↗</a>':'',
      '</div>',
      '<div class="manualPriceHero"><small>'+(buy?'ASK observado':'BID observado')+'</small><strong>'+numberOrDash(observed,priceDigits(observed))+'</strong><em>VWAP '+numberOrDash(vwap,priceDigits(vwap))+'</em></div>',
      '<dl class="manualFacts">',
      '<div><dt>Qtd. no topo</dt><dd>'+numberOrDash(topQty,8)+'</dd></div>',
      '<div><dt>Horário cotação</dt><dd>'+timeLabel(q?.ts)+'</dd></div>',
      '<div><dt>Idade no snapshot</dt><dd>'+ageLabel(q?.ts,capturedAt)+'</dd></div>',
      '<div><dt>'+(buy?'Limite de compra':'Limite de venda')+'</dt><dd>'+numberOrDash(limit,priceDigits(limit))+'</dd></div>',
      '<div><dt>Qtd. mínima</dt><dd>'+ruleValue(rules?.minQty)+'</dd></div>',
      '<div><dt>Step quantidade</dt><dd>'+ruleValue(rules?.qtyStep)+'</dd></div>',
      '<div><dt>Valor mínimo</dt><dd>'+(rules?.minNotional?rules.minNotional+' USDT':'—')+'</dd></div>',
      '<div><dt>Tick preço</dt><dd>'+ruleValue(rules?.tickSize)+'</dd></div>',
      '</dl></section>'
    ].join('');
  }

  function costHtml(route){
    const recomposition=Number.isFinite(Number(route?.netPnlUsdt))&&Number.isFinite(Number(route?.netAfterRebalanceUsdt))?Number(route.netPnlUsdt)-Number(route.netAfterRebalanceUsdt):null;
    const rows=[
      ['Bruto',route?.grossPnlUsdt,false],
      ['Taxa compra',route?.buyTradingFeeUsdt,true],
      ['Taxa venda',route?.sellTradingFeeUsdt,true],
      ['Reserva',route?.reserveUsdt,true],
      ['Líquido execução',route?.netPnlUsdt,false],
      ['Recomposição',recomposition,true],
      ['Após recomposição',route?.netAfterRebalanceUsdt,false]
    ];
    return rows.map(([name,value,cost])=>{
      const n=Number(value);
      const shown=Number.isFinite(n)?(cost?'-':'')+fmt(Math.abs(n),4)+' USDT':'—';
      return '<div><span>'+name+'</span><b class="'+(Number.isFinite(n)&&n>=0&&!cost?'positive':'')+'">'+shown+'</b></div>';
    }).join('');
  }

  function venuesHtml(route){
    const quotes=Array.isArray(route?.venueQuotes)?[...route.venueQuotes]:[];
    const chosen=[route?.buyExchange,route?.sellExchange];
    quotes.sort((a,b)=>{
      const ai=chosen.indexOf(a.exchange), bi=chosen.indexOf(b.exchange);
      return (ai===-1?99:ai)-(bi===-1?99:bi);
    });
    if(!quotes.length) return '<div class="emptyState">Sem mapa de preços no snapshot.</div>';
    return '<div class="manualVenueRows">'+quotes.map((q)=>{
      const role=q.exchange===route?.buyExchange?'COMPRA':(q.exchange===route?.sellExchange?'VENDA':'');
      return '<div class="manualVenueRow"><div><b>'+label(q.exchange)+'</b>'+(role?'<span>'+role+'</span>':'')+'</div><div><small>ask</small><strong>'+numberOrDash(q.ask,priceDigits(q.ask))+'</strong></div><div><small>bid</small><strong>'+numberOrDash(q.bid,priceDigits(q.bid))+'</strong></div><em>'+ageLabel(q.ts,capturedAt)+'</em></div>';
    }).join('')+'</div>';
  }

  function render(){
    if(!snapshot) return;
    const route=snapshot;
    const plan=route?.operationalPlan||{};
    const qty=plan?.baseQty||route?.baseQty;
    title.textContent=(route?.symbol||'—')+' · '+label(route?.buyExchange)+' → '+label(route?.sellExchange);
    time.textContent='Snapshot congelado às '+timeLabel(capturedAt)+' · atualize quando quiser comparar novamente';
    body.innerHTML=[
      '<div class="snapshotBanner"><div><span>SNAPSHOT CONGELADO</span><b>'+realityLabel(route)+'</b></div><small>Os números abaixo não mudam enquanto você confere as corretoras.</small></div>',
      '<div class="manualLegGrid">'+legHtml(route,'buy')+legHtml(route,'sell')+'</div>',
      '<section class="manualBlock"><div class="manualBlockHead"><b>Ordem simulada</b><small>mesma quantidade nas duas pontas</small></div>',
      '<div class="manualOrderGrid">',
      '<div><span>Quantidade</span><b>'+numberOrDash(qty,8)+'</b></div>',
      '<div><span>Executável</span><b>'+fmt(route?.executableBudgetUsdt||route?.budgetUsdt,2)+' USDT</b></div>',
      '<div><span>Spread bruto</span><b class="positive">+'+fmt(route?.grossSpreadPct,4)+'%</b></div>',
      '<div><span>Breakeven</span><b>'+fmt(route?.breakEvenPct,4)+'%</b></div>',
      '<div><span>Depth</span><b>'+Number(route?.buyDepthLevels||0)+' × '+Number(route?.sellDepthLevels||0)+'</b></div>',
      '<div><span>Confirmação</span><b>'+Number(route?.confirmationStreak||0)+'/'+Number(route?.confirmationsRequired||3)+'</b></div>',
      '</div></section>',
      '<section class="manualBlock"><div class="manualBlockHead"><b>De onde sai o lucro</b><small>USDT</small></div><div class="manualCostRows">'+costHtml(route)+'</div></section>',
      '<section class="manualBlock"><div class="manualBlockHead"><b>Preço nas corretoras</b><small>ask · bid · idade</small></div>'+venuesHtml(route)+'</section>',
      '<section class="manualChecklist"><b>Como conferir sem se perder</b><ol>',
      '<li>Abra as duas corretoras e confirme o mesmo par <strong>'+String(route?.symbol||'').replace('USDT','/USDT')+' Spot</strong>.</li>',
      '<li>Na compra compare o <strong>ask</strong>; na venda compare o <strong>bid</strong>. O “último preço” não é a referência de execução.</li>',
      '<li>Veja se o livro comporta <strong>'+numberOrDash(qty,8)+'</strong> unidades sem consumir preços muito piores.</li>',
      '<li>Se os números mudaram, volte e toque em <strong>Atualizar snapshot</strong> antes de concluir a conferência.</li>',
      '</ol><p>A corretora é a referência final antes de qualquer ordem. Fill não é garantido.</p></section>'
    ].join('');
  }

  function textSnapshot(){
    if(!snapshot) return '';
    const route=snapshot, plan=route?.operationalPlan||{};
    const buyQ=quote(route,route?.buyExchange), sellQ=quote(route,route?.sellExchange);
    return [
      'RADAR CRIPTO — SNAPSHOT '+timeLabel(capturedAt),
      (route?.symbol||'—')+' · '+label(route?.buyExchange)+' → '+label(route?.sellExchange),
      'Status: '+realityLabel(route),
      '',
      'COMPRAR — '+label(route?.buyExchange),
      'Ask: '+numberOrDash(buyQ?.ask,priceDigits(buyQ?.ask)),
      'VWAP: '+numberOrDash(route?.buyVwap,priceDigits(route?.buyVwap)),
      'Limite modelado: '+numberOrDash(plan?.buyLimitPrice,priceDigits(plan?.buyLimitPrice)),
      'Cotação: '+timeLabel(buyQ?.ts)+' · idade '+ageLabel(buyQ?.ts,capturedAt),
      '',
      'VENDER — '+label(route?.sellExchange),
      'Bid: '+numberOrDash(sellQ?.bid,priceDigits(sellQ?.bid)),
      'VWAP: '+numberOrDash(route?.sellVwap,priceDigits(route?.sellVwap)),
      'Limite modelado: '+numberOrDash(plan?.sellLimitPrice,priceDigits(plan?.sellLimitPrice)),
      'Cotação: '+timeLabel(sellQ?.ts)+' · idade '+ageLabel(sellQ?.ts,capturedAt),
      '',
      'Quantidade: '+numberOrDash(plan?.baseQty||route?.baseQty,8),
      'Executável: '+fmt(route?.executableBudgetUsdt||route?.budgetUsdt,2)+' USDT',
      'Spread: '+fmt(route?.grossSpreadPct,4)+'%',
      'Líquido execução: '+money(route?.netPnlUsdt),
      'Após recomposição: '+money(route?.netAfterRebalanceUsdt),
      'Breakeven: '+fmt(route?.breakEvenPct,4)+'%',
      '',
      'Fill não garantido.'
    ].join('\n');
  }

  function open(route){
    if(!route||!root) return;
    snapshot=cloneRoute(route);
    capturedAt=Date.now();
    render();
    root.hidden=false;
    root.setAttribute('aria-hidden','false');
    document.body.classList.add('auditOpen');
  }
  function close(){
    if(!root) return;
    root.hidden=true;
    root.setAttribute('aria-hidden','true');
    document.body.classList.remove('auditOpen');
  }
  function refresh(){
    const route=typeof getSelectedRoute==='function'?getSelectedRoute():null;
    if(!route) return;
    snapshot=cloneRoute(route);
    capturedAt=Date.now();
    render();
  }
  async function copy(){
    const text=textSnapshot();
    if(!text) return;
    try{ await navigator.clipboard.writeText(text); }
    catch{
      const area=document.createElement('textarea');
      area.value=text; area.style.position='fixed'; area.style.opacity='0';
      document.body.appendChild(area); area.select(); document.execCommand('copy'); area.remove();
    }
    if(copyBtn){ const old=copyBtn.textContent; copyBtn.textContent='Copiado ✓'; setTimeout(()=>{copyBtn.textContent=old;},1200); }
  }

  document.getElementById('manualAuditClose')?.addEventListener('click',close);
  document.querySelectorAll('[data-manual-audit-close]').forEach((el)=>el.addEventListener('click',close));
  document.getElementById('manualAuditRefresh')?.addEventListener('click',refresh);
  copyBtn?.addEventListener('click',copy);
  document.addEventListener('keydown',(event)=>{ if(event.key==='Escape'&&!root?.hidden) close(); });

  return {open,close,refresh,copy};
}
