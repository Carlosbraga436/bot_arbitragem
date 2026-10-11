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
  const entries=BASE.map(([id,symbol,name])=>({id,symbol,name,type:'FOREX',candles:[],tick:null,feedError:'',analysis:[],requestedAt:0,requests:0,historyCountDesired:2500,lastMinuteQueried:-1,marketOpen:null,listed:null,historyError:'',tickError:'',lastStatus:'Aguardando fonte',subscribed:false,marketOpenAt:0,rawOpen:null,suspended:null,subscribeAttempt:0,probeAttempted:false,nextOpenAt:null,marketClosedReason:''}));
  const bySymbol=new Map(entries.map(x=>[x.symbol,x]));
  const endpoints=['wss://api.derivws.com/trading/v1/options/ws/public','wss://ws.binaryws.com/websockets/v3'];
  let started=true, socket=null,connected=false,receivedSymbols=false,discovered=false,endpointIndex=0,reconnectTimer=null,probeTimer=null,heartbeat=null,attempt=0,market='ALL',expiry='ALL',detail=1,selected='EURUSD',payout=.8;
  let latestError='',eventCount=0,lastTickAt=0,subscriptionStart=0,historyCount=0,historyProbe=null,fallbackChecked=false,lastMetadataAt=0,marketMessages=0;
  let lastHistoryViewKey='',lastChartKey='',uiQueued=false;
  function nextFrame(){if(uiQueued)return;uiQueued=true;const task=()=>{uiQueued=false;render()};if(typeof window.requestAnimationFrame==='function')window.requestAnimationFrame(task);else setTimeout(task,0)}
  const diagnostics=[];
  function log(kind,message){diagnostics.unshift({at:new Date().toISOString(),kind,message:String(message||'').slice(0,280)});if(diagnostics.length>25)diagnostics.pop()}
  function nyClosed(){try{const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',weekday:'short',hour:'2-digit',hourCycle:'h23'}).formatToParts(new Date());const day=parts.find(x=>x.type==='weekday')?.value,h=Number(parts.find(x=>x.type==='hour')?.value);return day==='Sat'||day==='Fri'&&h>=17||day==='Sun'&&h<17}catch(_){return false}}
  function parseMarketOpening(detail){
    const m=String(detail||'').match(/market will open at\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/i);
    if(!m)return null;
    const date=new Date(m[1]+'T'+m[2]+'Z');
    return Number.isFinite(date.getTime())?date.getTime():null;
  }
  function nextOpen(){const times=entries.map(x=>x.nextOpenAt).filter(n=>Number.isFinite(n)&&n>Date.now()-60000);return times.length?Math.min(...times):null}
  function formatNextOpen(){const n=nextOpen();if(!n)return 'Horário ainda não informado pela fonte';
    const br=new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(n));
    const utc=new Intl.DateTimeFormat('pt-BR',{timeZone:'UTC',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(n));
    return br+' (São Paulo) · '+utc+' (UTC presumido)';
  }
  function remaining(){const n=nextOpen();if(!n)return '—';const secs=Math.max(0,Math.floor((n-Date.now())/1000));const h=Math.floor(secs/3600),m=Math.floor(secs%3600/60),s=secs%60;return h+'h '+String(m).padStart(2,'0')+'m '+String(s).padStart(2,'0')+'s'}
  function marketClosed(x){return x.marketOpen===false&&Date.now()-x.marketOpenAt<90000}
  function marketKnown(x){return x.marketOpenAt>0&&Date.now()-x.marketOpenAt<90000}
  function statusText(x){return marketKnown(x)?x.marketOpen===true?'ABERTO NA DERIV':x.marketOpen===false?'FECHADO NA DERIV':'STATUS NÃO INFORMADO':'STATUS NÃO CONFIRMADO'}
  function subscribe(x,force=false){
    if(!started||!connected||x.subscribed)return false;
    if(!force&&(marketClosed(x)||x.listed===false))return false;
    if(x.nextOpenAt&&Date.now()+10000<x.nextOpenAt&&x.marketOpen!==true)return false;
    const cooldown=force?55000:15000;
    if(Date.now()-x.subscribeAttempt<cooldown)return false;
    x.subscribeAttempt=Date.now();
    x.subscribed=safeSend({ticks:x.symbol,subscribe:1,req_id:200+BASE.findIndex(v=>v[0]===x.id)});
    if(x.subscribed)x.lastStatus='Assinatura de ticks solicitada';
    return x.subscribed;
  }
  function updateMarket(x,item,hasList){
    if(hasList)x.listed=Boolean(item);
    if(!item){if(hasList){x.marketOpen=null;x.rawOpen=null;x.marketOpenAt=Date.now();x.lastStatus='Ativo fora da lista atual da Deriv'}return}
    const raw=item.exchange_is_open,susp=item.is_trading_suspended;
    x.rawOpen=raw===undefined?null:raw;x.suspended=susp===undefined?null:susp;
    x.marketOpenAt=Date.now();
    x.marketOpen=Number(susp)===1?false:raw===undefined||raw===null?null:Number(raw)===1?true:Number(raw)===0?false:null;
    x.lastStatus=x.marketOpen===true?'Ativo aberto segundo Deriv':x.marketOpen===false?'Ativo fechado segundo Deriv':'Status não informado pela Deriv';
  }
  function errorFor(msg){const req=Number(msg?.req_id),sym=msg?.echo_req?.ticks_history||msg?.echo_req?.ticks||msg?.passthrough?.symbol||'';return {asset:bySymbol.get(sym)|| (Number.isInteger(req)&&req>=100&&req<100+BASE.length?entries[req-100]:Number.isInteger(req)&&req>=200&&req<200+BASE.length?entries[req-200]:null),operation:req>=100&&req<200?'history':req>=200&&req<300?'ticks':'general'};}
  const el=id=>document.getElementById(id);
  const label=(id,v)=>{const n=el(id);if(n)n.textContent=v};
  const current=()=>entries.find(x=>x.id===selected)||entries[0];
  const money=x=>typeof x==='number'&&Number.isFinite(x)?x.toLocaleString('pt-BR',{minimumFractionDigits:4,maximumFractionDigits:5}):'—';
  const seconds=x=>((Date.now()-x)/1000);
  function live(x){return started&&connected&&x.tick&&x.tick.received>0&&Date.now()-x.tick.received<4500&&Math.abs(Date.now()-x.tick.epoch*1000)<12000}
  function safeSend(msg){if(socket&&socket.readyState===WebSocket.OPEN){try{socket.send(JSON.stringify(msg));return true}catch(_){}}return false}
  function removeTimers(){if(reconnectTimer)clearTimeout(reconnectTimer);if(probeTimer)clearTimeout(probeTimer);if(historyProbe)clearTimeout(historyProbe);if(heartbeat)clearInterval(heartbeat);reconnectTimer=probeTimer=historyProbe=heartbeat=null}
  function stop(){
    removeTimers();
    if(socket){const s=socket;socket=null;s.onopen=s.onclose=s.onerror=s.onmessage=null;try{s.close()}catch(_){}}
    connected=false;receivedSymbols=false;discovered=false;for(const x of entries){x.tick=null;x.subscribed=false;x.probeAttempted=false;x.marketOpen=null;x.marketOpenAt=0}
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
  function queryHistory(x,force=false){if(!started||!connected)return;if(!force&&Date.now()-x.requestedAt<15000)return;x.requestedAt=Date.now();x.requests++;safeSend({ticks_history:x.symbol,style:'candles',granularity:60,count:x.historyCountDesired,end:'latest',adjust_start_time:1,req_id:100+BASE.findIndex(v=>v[0]===x.id)});}
  function activate(list){
    const hasList=Array.isArray(list);
    const meta=hasList?new Map(list.map(p=>[p.underlying_symbol||p.symbol,p])):null;
    lastMetadataAt=hasList?Date.now():lastMetadataAt;
    if(hasList)marketMessages++;
    const first=!discovered;
    if(first)discovered=true;
    for(const x of entries){
      if(hasList)updateMarket(x,meta.get(x.symbol),true);
      if(first)queryHistory(x,true);
      // Um probe inicial de leitura verifica se existem ticks apesar do status
      // de mercado reportado como fechado. Apenas uma vez por sessão.
      if(first&&!x.probeAttempted){
        x.probeAttempted=true;
        subscribe(x,true);
      }else if(x.marketOpen===true&&!x.subscribed)subscribe(x,false);
      // Se a fonte não enviar estado, a conexão não fica bloqueada indefinidamente.
      else if(!marketKnown(x)&&!x.subscribed)subscribe(x,false);
      // Sem assinaturas repetidas: um erro no domingo terá nova tentativa só
      // quando o ativo abrir ou após uma janela de recuperação controlada.
      else if(x.marketOpen===false&&!x.subscribed&&Date.now()-x.subscribeAttempt>75000&&!nyClosed())subscribe(x,true);
    }
    if(first){
      if(historyProbe)clearTimeout(historyProbe);
      historyProbe=setTimeout(()=>{
        if(!started||!connected||!socket||entries.some(x=>x.candles.length)||fallbackChecked)return;
        fallbackChecked=true;endpointIndex=(endpointIndex+1)%endpoints.length;
        log('conexão','Sem histórico na primeira API após 11s: testando canal alternativo');
        latestError='Sem retorno de histórico: tentando endpoint alternativo';
        socket.close();
      },11000);
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
      heartbeat=setInterval(()=>{if(socket===sock&&connected){safeSend({ping:1});safeSend({active_symbols:'brief',req_id:1})}},15000);
      render();
    };
    sock.onmessage=e=>{
      let m;try{m=JSON.parse(e.data)}catch(_){return}
      if(m.error){
        const trace=errorFor(m),detail=m.error.message||m.error.code||'Erro não especificado';
        if(trace.asset){
          if(trace.operation==='history'){
            trace.asset.historyError=detail;
            if(trace.asset.historyCountDesired>1000&&!trace.asset.candles.length&&
              /count|maximum|limit|too many|exceed|range/i.test(detail)){
              trace.asset.historyCountDesired=1000;
              setTimeout(()=>{if(started&&connected)queryHistory(trace.asset,true)},350);
              log('fonte','Histórico longo não aceito para '+trace.asset.id+'; repetindo com 1000 candles.');
            }
          }
          else if(trace.operation==='ticks'){trace.asset.tickError=detail;trace.asset.subscribed=false}
          trace.asset.feedError=detail;
          const open=parseMarketOpening(detail);
          if(open){trace.asset.nextOpenAt=open;trace.asset.marketClosedReason=detail;trace.asset.marketOpen=false;trace.asset.marketOpenAt=Date.now();}
          trace.asset.lastStatus=open||marketClosed(trace.asset)?'Forex fechado':trace.operation==='history'?'Falha ao obter histórico':'Erro da cotação';
          log('asset '+trace.asset.id,detail);
        }else{latestError=detail;log('API',detail)}
        if(m.msg_type==='active_symbols'&&!discovered)activate(null);
        render();return;
      }
      if(m.msg_type==='active_symbols'&&Array.isArray(m.active_symbols)){receivedSymbols=true;activate(m.active_symbols);return}
      if((m.msg_type==='candles'||Array.isArray(m.candles))&&Array.isArray(m.candles)){
        const sym=m.echo_req?.ticks_history||BASE[(m.req_id||100)-100]?.[1],x=bySymbol.get(sym);
        if(!x)return;
        x.candles=Engine.normalizeCandles(m.candles);
        x.historyError=x.candles.length?'':'Nenhum candle fechado válido na resposta';
        x.feedError=x.historyError;
        x.lastStatus=x.candles.length?'Histórico recebido':'Sem histórico válido';
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
        x.tick={price:p,epoch,received:Date.now()};x.tickError='';x.feedError='';x.marketOpen=true;x.marketOpenAt=Date.now();x.nextOpenAt=null;x.marketClosedReason='';x.lastStatus='Tick recebido';
        lastTickAt=Date.now();eventCount++;
        const last=x.candles.at(-1);
        if(last&&Math.floor(epoch/60)*60>=last.time+60){const minute=Math.floor(epoch/60);if(x.lastMinuteQueried!==minute){x.lastMinuteQueried=minute;queryHistory(x,true);setTimeout(()=>{if(started&&connected&&x.lastMinuteQueried===minute&&x.candles.at(-1)?.time<minute*60-60)queryHistory(x,true)},1700)}}
        nextFrame();return;
      }
    };
    sock.onerror=()=>{if(socket!==sock)return;latestError='Falha de rede/WebSocket. Verifique a internet ou restrições do navegador.';log('conexão',latestError);render()};
    sock.onclose=e=>{
      clearTimeout(watchdog);
      log('conexão','WebSocket encerrado'+(e&&e.code?' (código '+e.code+')':''));
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
      tag.textContent=live(x)?'AO VIVO':marketClosed(x)?'FECHADO NA DERIV':x.historyError&&!x.candles.length?'FALHA NO HISTÓRICO':x.candles.length?'HISTÓRICO OK':x.feedError?'ERRO DA FONTE':'AGUARDANDO DADOS';
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
      else if(!entries.some(live)&&entries.every(x=>marketClosed(x)))message='A Deriv informou que os 6 pares estão fechados. O histórico foi carregado, mas não há cotações executáveis ao vivo. O status é reconsultado automaticamente.';
      else if(!entries.some(live)&&entries.some(x=>marketClosed(x)))message='Alguns pares constam como fechados na Deriv. O radar verifica o status a cada 15 segundos e aguarda cotações frescas.';
      else if(!entries.some(x=>x.candles.length))message=entries.some(x=>x.historyError)?'A fonte respondeu com erro de histórico: '+entries.find(x=>x.historyError).historyError:'Conexão aberta. Aguardando retorno do histórico de candles.';
      else if(!entries.some(live))message='Sem ticks recentes. Confira o diagnóstico da fonte e a disponibilidade do mercado.';
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
    label('reason',r?r.reason:x.historyError||x.feedError||'Histórico de candles ainda não carregado.');
    label('assetDiagnostic',x.historyError?'Histórico: '+x.historyError:x.tickError?'Tick: '+x.tickError:marketClosed(x)?'Deriv informa fechado (exchange_is_open='+String(x.rawOpen)+'). Histórico disponível.':x.lastStatus);
    label('selectedPayout','Hipótese de '+Math.round(payout*100)+'%');
    label('selectedHistory',r&&r.sample?r.wins+'/'+r.sample+' ('+(r.winRate*100).toFixed(1)+'%)':'Sem amostra');
    label('selectedBaseline',r&&r.baseline.sample?r.baseline.wins+'/'+r.baseline.sample+' ('+(100*r.baseline.winRate).toFixed(1)+'%)':'Sem amostra');
    label('selectedTrain',r?r.train.sample+' ocorrências':'—');
    label('selectedRegime',r?r.regime:'Aguardando');
    label('selectedLower',r&&r.lower!==null?(r.lower*100).toFixed(1)+'%':'—');
    const svg=el('miniChart');if(svg){
      const chartKey=x.id+'|'+x.candles.length+'|'+(x.candles.at(-1)?.time||0);
      if(chartKey===lastChartKey)return;
      lastChartKey=chartKey;
      const rows=x.candles.slice(-60),ns='http://www.w3.org/2000/svg';svg.replaceChildren();
      if(rows.length>=3){
        const vals=rows.map(p=>p.close),lo=Math.min(...vals),hi=Math.max(...vals),range=hi-lo||1;
        const points=vals.map((n,i)=>(i/(vals.length-1)*310).toFixed(1)+','+(82-((n-lo)/range)*68).toFixed(1)).join(' ');
        const line=document.createElementNS(ns,'polyline');line.setAttribute('points',points);line.setAttribute('fill','none');line.setAttribute('stroke','#70e1ca');line.setAttribute('stroke-width','2.6');line.setAttribute('stroke-linecap','round');line.setAttribute('stroke-linejoin','round');svg.append(line);
      }
    }
  }
  function renderHistoryStudies(){
    const root=el('historyStudies');if(!root)return;
    const key=expiry+'|'+payout+'|'+entries.map(x=>x.id+':'+x.candles.length+':'+(x.candles.at(-1)?.time||0)).join('|');
    if(key===lastHistoryViewKey)return;
    lastHistoryViewKey=key;
    root.replaceChildren();
    const available=entries.filter(x=>x.candles.length>=500);
    const breakeven=1/(1+payout),tf=expiry==='ALL'?5:Number(expiry);
    label('historicalBreakEven',(breakeven*100).toFixed(1)+'%');
    label('historicalExpiryLabel',expiry==='ALL'?'5m (referência)':tf+'m');
    label('modelDescription','60% inicial de desenvolvimento · 40% final de avaliação cronológica');
    if(!available.length){
      const p=document.createElement('p');p.className='sub';
      p.textContent='Aguardando pelo menos 500 candles fechados. Histórico será analisado sem inventar resultados.';
      root.append(p);return;
    }
    for(const x of available){
      const r=x.analysis.find(k=>k.expiry===tf);if(!r)continue;
      const container=document.createElement('div');container.style.padding='13px 0';
      container.style.borderBottom='1px solid #26394a';
      const head=document.createElement('div');head.style.display='flex';
      head.style.justifyContent='space-between';head.style.alignItems='center';
      const name=document.createElement('strong');name.textContent=x.name+' · '+tf+'m';
      const period=document.createElement('span');period.className='count';period.textContent=x.candles.length+' velas disponíveis';
      head.append(name,period);container.append(head);
      function appendLine(title,stat){
        const row=document.createElement('div');row.className='rowinfo';
        const left=document.createElement('span');left.textContent=title;
        const right=document.createElement('b');right.style.textAlign='right';
        right.textContent=stat.sample?stat.wins+'/'+stat.sample+' ('+(stat.winRate*100).toFixed(1)+'%)':'Sem ocorrências';
        row.append(left,right);container.append(row);
      }
      appendLine('Estratégia anterior · teste 40%',r.baseline);
      appendLine('Nova estratégia · teste 40%',r);
      const sub=document.createElement('div');sub.className='sub';sub.style.marginTop='8px';
      const n=r.sample,w=r.lower===null?null:100*r.lower;
      sub.textContent=(n>0?'Limite inferior (IC unilateral 95%): '+w.toFixed(1)+'%. ':'Sem limite estatístico calculável. ')+
        'Treino: '+r.train.sample+' · Validação: '+n+'. '+
        (n<25||r.train.sample<30?'AMOSTRA INSUFICIENTE.':r.lower<=breakeven+.02?'Vantagem não demonstrada.':'Filtro histórico passou; necessita simulação prospectiva.');
      container.append(sub);root.append(container);
    }
    const foot=document.createElement('p');foot.className='sub';
    foot.textContent='Os dois métodos usam a mesma parte final do histórico, sem calibrar parâmetros sobre esse trecho. Ainda é pesquisa retrospectiva, sujeita a viés de seleção e a diferenças de cotação, spread, latência e payout da corretora. Menos operações não significa melhora comprovada.';
    root.append(foot);
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
    label('diagnosticSummary',latestError||(diagnostics.length?diagnostics[0].kind+': '+diagnostics[0].message:connected?'Sem erros detectados na conexão':'Aguardando WebSocket'));
    label('historyLoaded',entries.filter(x=>x.candles.length>0).length+' de '+entries.length);
    const open=entries.filter(x=>marketKnown(x)&&x.marketOpen===true).length,closed=entries.filter(marketClosed).length;
    label('marketStatus',entries.some(live)?'Ticks em '+entries.filter(live).length+' par(es)':!lastMetadataAt?'Aguardando status Deriv':open?'Deriv: '+open+' abertos · '+closed+' fechados':closed?'Deriv: '+closed+' fechados':'Status não informado');
    label('marketMetadata',lastMetadataAt?new Date(lastMetadataAt).toLocaleTimeString('pt-BR')+' · '+marketMessages+' consultas':'Aguardando resposta');
    label('sourceOpenRaw',current().rawOpen===null?'Não informado':String(current().rawOpen));
    label('nextOpening',formatNextOpen());
    label('openingCountdown',remaining());
    const banner=el('marketClosedBanner');if(banner)banner.style.display=entries.some(live)?'none':entries.some(x=>marketClosed(x))?'block':'none';
    renderHistoryStudies();
    pills();assetList();summarize();details();
  }
  const p=el('payoutInput');if(p){p.value=80;p.addEventListener('change',()=>{
    const n=Number(p.value);if(!Number.isFinite(n)||n<50||n>100){p.value=Math.round(payout*100);return}
    payout=n/100;for(const x of entries)if(x.candles.length)x.analysis=E.map(t=>Engine.score(x.candles,t,payout));
    render();
  })}
  el('toggle').addEventListener('click',()=>{started=!started;if(started){fallbackChecked=false;connect()}else stop()});
  el('expiry').addEventListener('click',e=>{const x=e.target.closest('[data-exp]');if(x){expiry=x.dataset.exp;render()}});
  el('detailExpiry').addEventListener('click',e=>{const x=e.target.closest('[data-detail]');if(x){detail=Number(x.dataset.detail);render()}});
  el('market').addEventListener('click',e=>{const x=e.target.closest('[data-mkt]');if(!x)return;market='FOREX';for(const b of el('market').querySelectorAll('button'))b.classList.toggle('active',b===x);render()});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();else if(started){fallbackChecked=false;connect()}});
  window.addEventListener('pagehide',stop);
  window.addEventListener('pageshow',()=>{if(started&&!document.hidden&&!socket)connect()});
  if('serviceWorker'in navigator&&location.protocol==='https:')navigator.serviceWorker.register('/sw.js').catch(()=>{});
  render();connect();
  setInterval(()=>{if(started&&!document.hidden){label('nLive',entries.filter(live).length);label('openingCountdown',remaining());if(entries.some(x=>x.tick))render()}},1200);
})();