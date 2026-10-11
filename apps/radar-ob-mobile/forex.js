/* Radar OB Mobile | Forex Deriv public feed | não é cotação IQ Option */
(function(){
  'use strict';
  const Engine=window.RadarEngine;
  const E=Engine.EXPIRIES;
  const BASE=[
    ['EURUSD','frxEURUSD','EUR/USD'],
    ['GBPUSD','frxGBPUSD','GBP/USD'],
    ['USDJPY','frxUSDJPY','USD/JPY'],
    ['EURJPY','frxEURJPY','EUR/JPY'],
    ['AUDUSD','frxAUDUSD','AUD/USD'],
    ['USDCHF','frxUSDCHF','USD/CHF']
  ];
  const entries=BASE.map(([id,symbol,name])=>({id,symbol,name,type:'FOREX',candles:[],tick:null,feedError:'',analysis:[],requestedAt:0,requests:0,lastMinuteQueried:-1}));
  const bySymbol=new Map(entries.map(x=>[x.symbol,x]));
  const endpoints=['wss://api.derivws.com/trading/v1/options/ws/public','wss://ws.binaryws.com/websockets/v3'];
  let started=true, socket=null,connected=false,receivedSymbols=false,discovered=false,endpointIndex=0,reconnectTimer=null,probeTimer=null,heartbeat=null,attempt=0,market='ALL',expiry='ALL',detail=1,selected='EURUSD',payout=.8;
  let latestError='',eventCount=0,lastTickAt=0,subscriptionStart=0,historyCount=0;
  const el=id=>document.getElementById(id);
  const label=(id,v)=>{const n=el(id);if(n)n.textContent=v};
  const current=()=>entries.find(x=>x.id===selected)||entries[0];
  const money=x=>typeof x==='number'&&Number.isFinite(x)?x.toLocaleString('pt-BR',{minimumFractionDigits:4,maximumFractionDigits:5}):'—';
  const seconds=x=>((Date.now()-x)/1000);
  function live(x){return started&&connected&&x.tick&&x.tick.received>0&&Date.now()-x.tick.received<4500&&Math.abs(Date.now()-x.tick.epoch*1000)<12000}
  function safeSend(msg){if(socket&&socket.readyState===WebSocket.OPEN){try{socket.send(JSON.stringify(msg));return true}catch(_){}}return false}
  function removeTimers(){if(reconnectTimer)clearTimeout(reconnectTimer);if(probeTimer)clearTimeout(probeTimer);if(heartbeat)clearInterval(heartbeat);reconnectTimer=probeTimer=heartbeat=null}
  function stop(){
    removeTimers();
    if(socket){const s=socket;socket=null;s.onopen=s.onclose=s.onerror=s.onmessage=null;try{s.close()}catch(_){}}
    connected=false;receivedSymbols=false;discovered=false;for(const x of entries)x.tick=null;
    render();
  }
  function queueRetry(reason){
    if(reason)latestError=reason;
    if(!started||document.hidden)return;
    if(reconnectTimer)return;
    attempt++;
    if(attempt%2===0)endpointIndex=(endpointIndex+1)%endpoints.length;
    reconnectTimer=setTimeout(()=>{reconnectTimer=null;connect()},Math.min(8000,2000+attempt*700));
  }
  function queryHistory(x,force=false){if(!started||!connected)return;if(!force&&Date.now()-x.requestedAt<15000)return;x.requestedAt=Date.now();x.requests++;safeSend({ticks_history:x.symbol,style:'candles',granularity:60,count:1000,end:'latest',req_id:100+BASE.findIndex(v=>v[0]===x.id)});}
  function activate(list){
    if(discovered)return;
    discovered=true;
    const supported=list?new Set(list.map(p=>p.symbol||p.underlying_symbol).filter(Boolean)):null;
    for(const x of entries){
      if(supported&&!supported.has(x.symbol)){x.feedError='Símbolo não disponível na fonte';continue}
      queryHistory(x);safeSend({ticks:x.symbol,subscribe:1,req_id:200+BASE.findIndex(v=>v[0]===x.id)});
    }
    render();
  }
  function connect(){
    if(!started||document.hidden)return;
    stop();
    latestError='';subscriptionStart=Date.now();
    let sock;
    try{sock=new WebSocket(endpoints[endpointIndex]);socket=sock}catch(e){queueRetry('Erro ao criar canal: '+String(e.message||e));render();return}
    const watchdog=setTimeout(()=>{if(socket===sock&&!connected){try{sock.close()}catch(_){};queueRetry('A fonte não respondeu a tempo.')}},9500);
    sock.onopen=()=>{
      clearTimeout(watchdog);if(socket!==sock)return;
      connected=true;attempt=0;subscriptionStart=Date.now();safeSend({active_symbols:'brief',req_id:1});
      probeTimer=setTimeout(()=>{if(socket===sock&&!discovered)activate(null)},2300);
      heartbeat=setInterval(()=>{if(socket===sock&&connected)safeSend({ping:1})},25000);
      render();
    };
    sock.onmessage=e=>{
      let m;try{m=JSON.parse(e.data)}catch(_){return}
      if(m.error){const id=m.echo_req?.ticks_history||m.echo_req?.ticks;const affected=bySymbol.get(id);
        if(affected)affected.feedError=m.error.message||m.error.code||'Erro de fonte';
        else latestError=m.error.message||m.error.code||'Falha na consulta';
        if(m.msg_type==='active_symbols'&&!discovered)activate(null);
        render();return;
      }
      if(m.msg_type==='active_symbols'&&Array.isArray(m.active_symbols)){receivedSymbols=true;activate(m.active_symbols);return}
      if((m.msg_type==='candles'||Array.isArray(m.candles))&&Array.isArray(m.candles)){
        const sym=m.echo_req?.ticks_history||BASE[(m.req_id||100)-100]?.[1],x=bySymbol.get(sym);
        if(!x)return;
        x.candles=Engine.normalizeCandles(m.candles);
        x.feedError=x.candles.length?'':'Fonte sem candles disponíveis';
        x.analysis=E.map(t=>Engine.score(x.candles,t,payout));
        historyCount++;render();return;
      }
      if(m.msg_type==='tick'&&m.tick){
        const sym=m.tick.symbol||m.echo_req?.ticks, x=bySymbol.get(sym);
        if(!x)return;
        const p=Number(m.tick.quote),epoch=Number(m.tick.epoch);
        if(!Number.isFinite(p)||p<=0||!Number.isFinite(epoch))return;
        if(epoch*1000>Date.now()+10000||Date.now()-epoch*1000>30000)return;
        const past=x.tick?.epoch??0;
        if(epoch<past)return;
        x.tick={price:p,epoch,received:Date.now()};
        lastTickAt=Date.now();eventCount++;
        const last=x.candles.at(-1);
        if(last&&Math.floor(epoch/60)*60>=last.time+60){const minute=Math.floor(epoch/60);if(x.lastMinuteQueried!==minute){x.lastMinuteQueried=minute;queryHistory(x,true);setTimeout(()=>{if(started&&connected&&x.lastMinuteQueried===minute&&x.candles.at(-1)?.time<minute*60-60)queryHistory(x,true)},1700)}}
        render();return;
      }
    };
    sock.onerror=()=>{if(socket!==sock)return;latestError='Não foi possível receber dados da fonte Forex.';render()};
    sock.onclose=()=>{
      clearTimeout(watchdog);
      if(socket!==sock)return;
      socket=null;connected=false;removeTimers();
      for(const x of entries)x.tick=null;
      render();queueRetry(latestError||'Canal encerrado pela fonte de mercado.');
    };
    render();
  }
  function qualified(x,r,now=Date.now()){
    if(!live(x)||!r.qualified)return false;
    if(!r.lastCandle||now-(r.lastCandle+60)*1000>8000||now-(r.lastCandle+60)*1000<0)return false;
    if(x.tick.epoch*1000< (r.lastCandle+60)*1000)return false;
    const bar=x.candles.at(-1);
    if(!bar)return false;
    const width=Math.max(bar.high-bar.low,bar.close*.000015);
    return Math.abs(x.tick.price-bar.close)<width*.55;
  }
  function scenarios(){return entries.flatMap(x=>x.analysis.filter(r=>expiry==='ALL'||r.expiry===Number(expiry)).map(r=>({x,r,active:qualified(x,r)})))}
  function chip(name,attr,value,selectedValue){const b=document.createElement('button');b.className='chip'+(String(value)===String(selectedValue)?' active':'');b.textContent=name;b.dataset[attr]=value;return b}
  function pills(){
    const a=el('expiry'),b=el('detailExpiry');
    a.replaceChildren(chip('Todos','exp','ALL',expiry));b.replaceChildren();
    for(const x of E){a.appendChild(chip(x+'m','exp',String(x),expiry));b.appendChild(chip(x+'m','detail',String(x),detail))}
  }
  function assetList(){
    const node=el('assets');node.replaceChildren();
    for(const x of entries){
      const n=document.createElement('button');n.className='asset'+(x.id===selected?' selected':'');
      const left=document.createElement('div'),h=document.createElement('div'),d=document.createElement('div');
      h.className='asset-name';h.textContent=x.name;
      d.className='asset-caption';d.textContent='FOREX · '+(x.candles.length?x.candles.length+' candles fechados':'sem histórico');
      left.append(h,d);
      const right=document.createElement('div'),tag=document.createElement('div'),price=document.createElement('div');
      right.className='asset-right';tag.className='status';price.className='val';
      tag.textContent=live(x)?'AO VIVO':x.feedError?'ERRO DA FONTE':x.candles.length?'AGUARDANDO TICK':'SEM COTAÇÃO';
      price.textContent=live(x)?money(x.tick.price):'—';right.append(tag,price);n.append(left,right);
      n.addEventListener('click',()=>{selected=x.id;render();el('analysis').scrollIntoView({behavior:'smooth'})});
      node.append(n);
    }
  }
  function summarize(){
    const area=el('signals'),empty=el('emptyContainer');if(!area)return;
    area.replaceChildren();
    const items=scenarios();
    const candidates=items.filter(o=>o.active).sort((a,b)=>b.r.lower-a.r.lower);
    const studies=items.filter(o=>o.r.watch&&!o.active&&live(o.x)).slice(0,4);
    label('nSignals',candidates.length);
    if(!candidates.length){empty.style.display='';label('emptytitle','Nenhum sinal validado');
      let message='';
      if(!connected)message=latestError||'Conectando ao mercado Forex público da Deriv.';
      else if(!entries.some(x=>x.candles.length))message='Conexão iniciada. Aguardando histórico de candles para calcular os indicadores.';
      else if(!entries.some(live))message='Sem ticks recentes. Pode ser mercado fechado ou indisponibilidade temporária da fonte.';
      else message='Nenhum cenário atende simultaneamente a tendência, estatística e janela de entrada. Isso é normal.';
      label('emptytext',message);
    }else{
      empty.style.display='none';
      for(const {x,r} of candidates.slice(0,6)){
        const btn=document.createElement('button');
        btn.className='asset';btn.style.borderColor='#6bcab9';
        const l=document.createElement('div'),h=document.createElement('div'),s=document.createElement('div');
        h.className='asset-name';h.textContent=x.name+' · '+r.expiry+'m · '+r.dir;
        s.className='asset-caption';s.textContent='Candidato teórico · '+r.sample+' testes · acertos '+(r.winRate*100).toFixed(1)+'%';
        l.append(h,s);
        const right=document.createElement('div');right.className='asset-right';
        const w=document.createElement('div');w.className='status';w.style.color='#7be7c5';w.textContent='ESTUDO';
        const price=document.createElement('div');price.className='val';price.textContent=money(x.tick.price);right.append(w,price);
        btn.append(l,right);btn.addEventListener('click',()=>{selected=x.id;detail=r.expiry;render();el('analysis').scrollIntoView({behavior:'smooth'})});
        area.append(btn);
      }
    }
    const studyBox=el('studyBox');if(studyBox){studyBox.replaceChildren();if(studies.length){
      const h=document.createElement('p');h.className='sub';h.textContent='Padrões observados, ainda sem validação suficiente (não são entradas):';studyBox.append(h);
      for(const {x,r} of studies){const d=document.createElement('div');d.className='rowinfo';const name=document.createElement('span');name.textContent=x.name+' · '+r.expiry+'m';const desc=document.createElement('b');desc.textContent=r.dir+' · '+r.sample+' amostras';d.append(name,desc);studyBox.append(d)}
    }}}
  function details(){
    const x=current(),r=x.analysis.find(v=>v.expiry===detail);
    label('selectedName',x.name);label('selectedType','FOREX');
    label('selectedPrice',live(x)?money(x.tick.price):'—');
    label('age',x.tick?seconds(x.tick.received).toFixed(1)+' s':'Indisponível');
    label('direction',r&&qualified(x,r)?r.dir+' · ESTUDO':'SEM ENTRADA');
    label('reason',r?r.reason:'Histórico de candles ainda não carregado.');
    label('selectedPayout','Hipótese de '+Math.round(payout*100)+'%');
    label('selectedHistory',r&&r.sample?r.wins+'/'+r.sample+' ('+(r.winRate*100).toFixed(1)+'%)':'Insuficiente');
    label('selectedLower',r&&r.lower!==null?(r.lower*100).toFixed(1)+'%':'—');
    const svg=el('miniChart');if(svg){
      const rows=x.candles.slice(-60),ns='http://www.w3.org/2000/svg';svg.replaceChildren();
      if(rows.length>=3){
        const vals=rows.map(p=>p.close),lo=Math.min(...vals),hi=Math.max(...vals),range=hi-lo||1;
        const points=vals.map((n,i)=>(i/(vals.length-1)*310).toFixed(1)+','+(82-((n-lo)/range)*68).toFixed(1)).join(' ');
        const line=document.createElementNS(ns,'polyline');line.setAttribute('points',points);line.setAttribute('fill','none');line.setAttribute('stroke','#70e1ca');line.setAttribute('stroke-width','2.6');line.setAttribute('stroke-linecap','round');line.setAttribute('stroke-linejoin','round');svg.append(line);
      }
    }
  }
  function render(){
    label('nAssets',entries.length);label('nLive',entries.filter(live).length);
    label('nListed',entries.length+' ativos');
    label('scenario',entries.length*(expiry==='ALL'?E.length:1)+' combinações');
    label('events',eventCount);
    label('last',lastTickAt?new Date(lastTickAt).toLocaleTimeString('pt-BR'):'—');
    label('net',connected?'Deriv conectada':started?'Conectando':'Pausado');
    el('dot').classList.toggle('on',connected&&entries.some(live));
    label('scanState',!started?'Busca pausada':connected?entries.some(live)?'Ticks ao vivo · análise por eventos':'Conectado · aguardando mercado':'Conectando à Deriv');
    el('pulse').classList.toggle('off',!started||!entries.some(live));
    label('toggle',started?'Pausar busca':'Retomar busca');
    el('toggle').classList.toggle('paused',!started);
    label('channel',connected?'WebSocket conectado':'Desconectado');
    label('feed',entries.some(live)?'Deriv Forex · ticks ao vivo':connected?'Fonte ligada · sem tick recente':'Indisponível');
    label('provider','Deriv · Forex público');
    label('providerDetail','Fonte externa, diferente da IQ Option');
    pills();assetList();summarize();details();
  }
  const p=el('payoutInput');if(p){p.value=80;p.addEventListener('change',()=>{
    const n=Number(p.value);if(!Number.isFinite(n)||n<50||n>100){p.value=Math.round(payout*100);return}
    payout=n/100;for(const x of entries)if(x.candles.length)x.analysis=E.map(t=>Engine.score(x.candles,t,payout));
    render();
  })}
  el('toggle').addEventListener('click',()=>{started=!started;if(started)connect();else stop()});
  el('expiry').addEventListener('click',e=>{const x=e.target.closest('[data-exp]');if(x){expiry=x.dataset.exp;render()}});
  el('detailExpiry').addEventListener('click',e=>{const x=e.target.closest('[data-detail]');if(x){detail=Number(x.dataset.detail);render()}});
  el('market').addEventListener('click',e=>{const x=e.target.closest('[data-mkt]');if(!x)return;market='FOREX';for(const b of el('market').querySelectorAll('button'))b.classList.toggle('active',b===x);render()});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();else if(started)connect()});
  window.addEventListener('pagehide',stop);
  window.addEventListener('pageshow',()=>{if(started&&!document.hidden&&!socket)connect()});
  if('serviceWorker'in navigator&&location.protocol==='https:')navigator.serviceWorker.register('/sw.js').catch(()=>{});
  render();connect();
  setInterval(()=>{if(started&&!document.hidden){label('nLive',entries.filter(live).length);if(entries.some(x=>x.tick))render();}},1200);
})();