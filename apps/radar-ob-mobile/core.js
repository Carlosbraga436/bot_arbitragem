/* Radar OB Forex | motor de análise puramente local. Não executa ordens. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.RadarEngine=api;
})(typeof window!=='undefined'?window:null,function(){
  'use strict';
  const EXPIRIES=[1,2,3,5,10,15,30], Z=1.6448536269514722;
  const finite=n=>typeof n==='number'&&Number.isFinite(n);
  function normalizeCandles(raw,nowMs=Date.now()){
    if(!Array.isArray(raw))return [];
    const rows=raw.map(c=>({time:Number(c.epoch??c.time),open:Number(c.open),high:Number(c.high),low:Number(c.low),close:Number(c.close)}))
      .filter(c=>Number.isInteger(c.time)&&[c.open,c.high,c.low,c.close].every(n=>finite(n)&&n>0)&&c.high>=Math.max(c.open,c.close,c.low)&&c.low<=Math.min(c.open,c.close,c.high)&&c.time*1000+60000<=nowMs-1000)
      .sort((a,b)=>a.time-b.time);
    const dedup=[];for(const c of rows){if(dedup.length&&dedup[dedup.length-1].time===c.time)dedup[dedup.length-1]=c;else dedup.push(c)}
    return dedup.slice(-1200);
  }
  function indicators(rows){
    const c=rows.map(r=>r.close),n=c.length;
    function ema(p){const o=Array(n).fill(null),k=2/(p+1);let sum=0;for(let i=0;i<n;i++){sum+=c[i];if(i<p-1)continue;if(i===p-1)o[i]=sum/p;else o[i]=o[i-1]+k*(c[i]-o[i-1])}return o}
    function rsi(p){const o=Array(n).fill(null);if(n<=p)return o;let u=0,d=0;for(let i=1;i<=p;i++){const v=c[i]-c[i-1];u+=Math.max(0,v);d+=Math.max(0,-v)}u/=p;d/=p;const calc=()=>d===0?(u===0?50:100):100-100/(1+u/d);o[p]=calc();for(let i=p+1;i<n;i++){const v=c[i]-c[i-1];u=(u*(p-1)+Math.max(v,0))/p;d=(d*(p-1)+Math.max(-v,0))/p;o[i]=calc()}return o}
    const a=Array(n).fill(null);if(n>=14){let sum=0;for(let i=0;i<n;i++){const r=rows[i],prev=rows[i-1],tr=prev?Math.max(r.high-r.low,Math.abs(r.high-prev.close),Math.abs(r.low-prev.close)):r.high-r.low;if(i<14)sum+=tr;if(i===13)a[i]=sum/14;else if(i>13)a[i]=(a[i-1]*13+tr)/14}}
    return {e9:ema(9),e21:ema(21),e50:ema(50),rsi:rsi(14),atr:a};
  }
  function setup(i,rows,v){
    if(i<60||!finite(v.e50[i])||!finite(v.rsi[i])||!finite(v.atr[i])||!finite(v.rsi[i-1]))return null;
    if(rows[i].time-rows[i-1].time!==60)return null;
    const c=rows[i],range=c.high-c.low,avg=v.atr[i],body=Math.abs(c.close-c.open);
    if(avg<=0||range<avg*.3||range>avg*2.7||range<=0||body<range*.28)return null;
    if(v.e9[i]>v.e21[i]&&v.e21[i]>v.e50[i]&&c.close>v.e9[i]&&c.close>c.open&&v.rsi[i]>=52&&v.rsi[i]<=67&&v.rsi[i]>v.rsi[i-1])return 'CALL';
    if(v.e9[i]<v.e21[i]&&v.e21[i]<v.e50[i]&&c.close<v.e9[i]&&c.close<c.open&&v.rsi[i]<=48&&v.rsi[i]>=33&&v.rsi[i]<v.rsi[i-1])return 'PUT';
    return null;
  }
  function lower(w,n){if(n<=0)return 0;const p=w/n,z2=Z*Z;return (p+z2/(2*n)-Z*Math.sqrt(p*(1-p)/n+z2/(4*n*n)))/(1+z2/n)}
  function score(rows,expiry,payout=0.8,nowMs=Date.now()){
    if(!EXPIRIES.includes(expiry))throw Error('Vencimento inválido');
    const out={expiry,dir:null,qualified:false,watch:false,sample:0,wins:0,winRate:null,lower:null,breakeven:1/(1+payout),price:null,reason:'',ageSec:null,lastCandle:null};
    if(rows.length<250){out.reason='Histórico insuficiente: mínimo 250 candles fechados.';return out}
    const last=rows[rows.length-1];const age=nowMs-(last.time+60)*1000;out.ageSec=Math.max(0,age/1000);out.lastCandle=last.time;
    const v=indicators(rows),tail=rows.length-1;
    const current=setup(tail,rows,v);out.watch=Boolean(current);out.dir=current;out.price=last.close;
    const start=Math.max(110,Math.floor(rows.length*.60));let lastEnd=-1,w=0,n=0;
    for(let i=start;i<tail-expiry+1;i++){
      if(i<=lastEnd)continue;
      const dir=setup(i,rows,v);if(!dir)continue;
      let contiguous=true;
      for(let j=i+1;j<=i+expiry;j++)if(!rows[j]||rows[j].time-rows[j-1].time!==60){contiguous=false;break}
      if(!contiguous)continue;
      const entry=rows[i+1].open,exit=rows[i+expiry].close;
      if(dir==='CALL'?exit>entry:exit<entry)w++;
      n++;lastEnd=i+expiry;
    }
    out.sample=n;out.wins=w;out.winRate=n?w/n:null;out.lower=n?lower(w,n):null;
    if(age< -1000||age>85000){out.reason='Mercado fechado ou preços atrasados. Histórico disponível só para estudo.';return out}
    if(!current){out.reason='Sem configuração técnica nesta última vela.';return out}
    if(n<30){out.reason='Padrão '+current+' observado, mas só '+n+'/30 amostras históricas não sobrepostas.';return out}
    if(out.lower<=out.breakeven+.02){out.reason='Padrão '+current+' sem vantagem estatística demonstrada sobre payout hipotético.';return out}
    out.qualified=true;out.reason='Candidato teórico '+current+'; requer preço executável e payout da corretora antes de qualquer operação.';
    return out;
  }
  return {EXPIRIES,normalizeCandles,indicators,setup,lower,score};
});