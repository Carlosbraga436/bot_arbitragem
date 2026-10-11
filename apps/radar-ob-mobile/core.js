/* Radar OB V7 — pesquisa, sem ordens ou indicação executável.
   Regras fixas; comparação cronológica sem usar candles futuros para gerar sinais. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.RadarEngine=api;
})(typeof window!=='undefined'?window:null,function(){
'use strict';
const EXPIRIES=[1,2,3,5,10,15,30];
const Z=1.6448536269514722; // Limite de Wilson unilateral 95% (ou bilateral 90%).
const finite=x=>typeof x==='number'&&Number.isFinite(x);
function normalizeCandles(raw,nowMs=Date.now()){
  if(!Array.isArray(raw))return [];
  const rows=raw.map(c=>({time:Number(c.epoch??c.time),open:Number(c.open),high:Number(c.high),low:Number(c.low),close:Number(c.close)}))
    .filter(c=>Number.isInteger(c.time)&&[c.open,c.high,c.low,c.close].every(x=>finite(x)&&x>0)
      &&c.high>=Math.max(c.open,c.close,c.low)&&c.low<=Math.min(c.open,c.close,c.high)
      &&c.time*1000+60000<=nowMs-1000).sort((a,b)=>a.time-b.time);
  const unique=[];
  for(const row of rows){if(unique.length&&unique.at(-1).time===row.time)unique[unique.length-1]=row;else unique.push(row)}
  return unique.slice(-10000);
}
function indicators(rows){
  const close=rows.map(r=>r.close),n=close.length;
  function ema(p){
    const arr=Array(n).fill(null);let sum=0;
    const k=2/(p+1);
    for(let i=0;i<n;i++){
      sum+=close[i];
      if(i===p-1)arr[i]=sum/p;
      else if(i>=p)arr[i]=arr[i-1]+k*(close[i]-arr[i-1]);
    }
    return arr;
  }
  function rsi(p){
    const out=Array(n).fill(null);if(n<=p)return out;
    let gain=0,loss=0;
    for(let i=1;i<=p;i++){const ch=close[i]-close[i-1];gain+=Math.max(0,ch);loss+=Math.max(0,-ch)}
    gain/=p;loss/=p;
    const calc=()=>loss===0?(gain===0?50:100):100-100/(1+gain/loss);
    out[p]=calc();
    for(let i=p+1;i<n;i++){
      const ch=close[i]-close[i-1];
      gain=(gain*(p-1)+Math.max(ch,0))/p;
      loss=(loss*(p-1)+Math.max(-ch,0))/p;
      out[i]=calc();
    }
    return out;
  }
  const atr=Array(n).fill(null);
  let sum=0;
  for(let i=0;i<n;i++){
    const r=rows[i],p=rows[i-1];
    const tr=p?Math.max(r.high-r.low,Math.abs(r.high-p.close),Math.abs(r.low-p.close)):r.high-r.low;
    if(i<14)sum+=tr;
    if(i===13)atr[i]=sum/14;
    else if(i>13)atr[i]=(atr[i-1]*13+tr)/14;
  }
  // Média de ATR para identificar regime, calculada só com dados já vistos.
  const atrAvg=Array(n).fill(null);
  let atrSum=0;
  for(let i=14;i<n;i++){
    atrSum+=atr[i];
    if(i>=34)atrSum-=atr[i-20];
    if(i>=33)atrAvg[i]=atrSum/20;
  }
  return {e9:ema(9),e21:ema(21),e50:ema(50),rsi:rsi(14),atr,atrAvg};
}
function gapOK(i,rows){
  return i>0&&rows[i].time-rows[i-1].time===60;
}
// Estratégia antiga mantida SEM ajustes para comparação justa.
function setup(i,rows,v){
  if(i<60||!gapOK(i,rows)||![v.e50[i],v.rsi[i],v.rsi[i-1],v.atr[i]].every(finite))return null;
  const c=rows[i],range=c.high-c.low,avg=v.atr[i],body=Math.abs(c.close-c.open);
  if(avg<=0||range<avg*.3||range>avg*2.7||range<=0||body<range*.28)return null;
  if(v.e9[i]>v.e21[i]&&v.e21[i]>v.e50[i]&&c.close>v.e9[i]&&c.close>c.open&&v.rsi[i]>=52&&v.rsi[i]<=67&&v.rsi[i]>v.rsi[i-1])return 'CALL';
  if(v.e9[i]<v.e21[i]&&v.e21[i]<v.e50[i]&&c.close<v.e9[i]&&c.close<c.open&&v.rsi[i]<=48&&v.rsi[i]>=33&&v.rsi[i]<v.rsi[i-1])return 'PUT';
  return null;
}
// Filtro NOVO de regime e qualidade do candle: hipótese pré-fixada, não otimizada pelo holdout.
// Chama a estratégia antiga, mas rejeita congestão, volatilidade anormal, exaustão e contra-sombra.
function enhancedSetup(i,rows,v,expiry){
  const dir=setup(i,rows,v);
  if(!dir||i<70||!EXPIRIES.includes(expiry))return null;
  const c=rows[i],prev=rows[i-1],a=v.atr[i],mean=v.atrAvg[i];
  if(!finite(mean)||mean<=0||a<=0||!gapOK(i,rows)||!gapOK(i-1,rows))return null;
  const vol=a/mean;
  if(vol<.65||vol>1.65)return null;
  const slope=(v.e21[i]-v.e21[i-4])/a;
  const trendGap=Math.abs(v.e21[i]-v.e50[i])/a;
  const shortGap=Math.abs(v.e9[i]-v.e21[i])/a;
  if(!finite(slope)||trendGap<.27||shortGap<.10)return null;
  if(dir==='CALL'&&slope<.12||dir==='PUT'&&slope>-.12)return null;
  const range=c.high-c.low,body=Math.abs(c.close-c.open);
  if(range<=0||body/range<.43||range/a<.45||range/a>1.70)return null;
  const wick=dir==='CALL'?c.high-c.close:c.close-c.low;
  if(wick/range>.27)return null;
  const dist=Math.abs(c.close-v.e21[i])/a;
  if(dist>1.8)return null; // Evitar entrar em movimento esticado.
  // Expirações curtas e longas têm risco distinto; thresholds pré-fixados e sem otimização.
  if(expiry<=2){
    if(dist>1.15||dir==='CALL'&&v.rsi[i]>63||dir==='PUT'&&v.rsi[i]<37)return null;
  }else if(expiry>=10){
    if(trendGap<.42||dir==='CALL'&&v.rsi[i]>65||dir==='PUT'&&v.rsi[i]<35)return null;
  }else{
    // Expirações intermediárias: exigir retomada consistente, evitando reversões isoladas.
    if(dir==='CALL'&&c.close<=prev.close||dir==='PUT'&&c.close>=prev.close)return null;
  }
  return dir;
}
function lower(w,n){if(n<=0)return null;const p=w/n,z2=Z*Z;return (p+z2/(2*n)-Z*Math.sqrt((p*(1-p)+z2/(4*n))/n))/(1+z2/n)}
function runBacktest(rows,ind,expiry,signal,start,endExclusive){
  let n=0,w=0,ties=0,lastExit=-1;
  const limit=Math.min(endExclusive,rows.length)-expiry;
  for(let i=Math.max(70,start);i<limit;i++){
    if(i<=lastExit)continue;
    const dir=signal(i,rows,ind,expiry);
    if(!dir)continue;
    let contiguous=true;
    for(let j=i+1;j<=i+expiry;j++)if(!rows[j]||rows[j].time-rows[j-1].time!==60){contiguous=false;break}
    if(!contiguous)continue;
    const entry=rows[i+1].open,exit=rows[i+expiry].close;
    const diff=dir==='CALL'?exit-entry:entry-exit;
    if(diff>0)w++;
    else if(diff===0)ties++;
    n++;lastExit=i+expiry; // Evita múltiplos testes sobrepostos no mesmo par/prazo.
  }
  return {sample:n,wins:w,ties,winRate:n?w/n:null,lower:lower(w,n)};
}
function score(rows,expiry,payout=.80,nowMs=Date.now(),sharedIndicators=null){
  if(!EXPIRIES.includes(expiry))throw Error('Vencimento inválido');
  if(!finite(payout)||payout<.5||payout>1)throw Error('Payout fora de 50%-100%');
  const out={
    expiry,dir:null,qualified:false,watch:false,sample:0,wins:0,winRate:null,lower:null,
    breakeven:1/(1+payout),price:null,reason:'',ageSec:null,lastCandle:null,
    train:{sample:0,wins:0,winRate:null,lower:null},
    baseline:{sample:0,wins:0,winRate:null,lower:null},
    holdoutRatio:.40,confidence:'Wilson unilateral 95%',mode:'enhanced-v8-history',
    stability:{early:{sample:0,wins:0,winRate:null},late:{sample:0,wins:0,winRate:null}},
    historyBars:rows.length,regime:'DESCONHECIDO',potential:false
  };
  if(rows.length<500){out.reason='São necessários 500 candles fechados para separar treino e validação.';return out}
  const last=rows.at(-1),tail=rows.length-1,age=nowMs-(last.time+60)*1000;
  out.ageSec=Math.max(0,age/1000);out.lastCandle=last.time;out.price=last.close;
  const ind=sharedIndicators||indicators(rows);
  const cutoff=Math.floor(rows.length*.60); // 60% desenvolvimento, 40% validação cronológica.
  const train=runBacktest(rows,ind,expiry,enhancedSetup,70,cutoff);
  const test=runBacktest(rows,ind,expiry,enhancedSetup,cutoff,rows.length-1);
  const mid=cutoff+Math.floor((rows.length-1-cutoff)/2);
  const stability={
    early:runBacktest(rows,ind,expiry,enhancedSetup,cutoff,mid),
    late:runBacktest(rows,ind,expiry,enhancedSetup,mid,rows.length-1)
  };
  const baseline=runBacktest(rows,ind,expiry,setup,cutoff,rows.length-1);
  Object.assign(out,{train,baseline,stability,sample:test.sample,wins:test.wins,winRate:test.winRate,lower:test.lower});
  const baseDir=setup(tail,rows,ind),advanced=enhancedSetup(tail,rows,ind,expiry);
  out.potential=Boolean(baseDir);out.watch=Boolean(advanced);out.dir=advanced;
  const a=ind.atr[tail],av=ind.atrAvg[tail];
  if(finite(a)&&finite(av)&&av>0){
    const ratio=a/av,span=Math.abs(ind.e21[tail]-ind.e50[tail])/a;
    out.regime=ratio<.65?'VOLATILIDADE BAIXA':ratio>1.65?'VOLATILIDADE ELEVADA':span<.27?'LATERAL / INDEFINIDO':'TENDÊNCIA IDENTIFICADA';
  }
  if(age< -1000||age>85000){out.reason='Sem cotação recente: resultado histórico disponível, entradas bloqueadas.';return out}
  if(!advanced){out.reason=baseDir?'Padrão antigo observado, mas bloqueado por filtros de tendência, volatilidade ou vela.':'Sem padrão técnico com os critérios atuais.';return out}
  if(train.sample<30){out.reason='Padrão '+advanced+' com apenas '+train.sample+' ocorrências no treino (mínimo 30).';return out}
  if(test.sample<25){out.reason='Padrão '+advanced+' com apenas '+test.sample+' ocorrências na validação cronológica (mínimo 25).';return out}
  if(stability.early.sample<10||stability.late.sample<10){
    out.reason='Amostras insuficientes nas duas janelas cronológicas de validação.';return out
  }
  if(stability.early.winRate<=out.breakeven||stability.late.winRate<=out.breakeven){
    out.reason='Resultado inconsistente entre as duas janelas de validação; sinal bloqueado.';return out
  }
  if(test.lower===null||test.lower<=out.breakeven+.02){out.reason='Sem vantagem estatística demonstrada na validação independente. Não é entrada.';return out}
  out.qualified=true;
  out.reason='Candidato experimental: validação retrospectiva passou, mas falta simulação prospectiva, cotação e payout executáveis.';
  return out;
}
return {EXPIRIES,normalizeCandles,indicators,setup,enhancedSetup,runBacktest,lower,score};
});