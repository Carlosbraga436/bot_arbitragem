'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const PORT=Number(process.env.PORT||3000), ROOT=__dirname;
const ids=['EURUSD','GBPUSD','USDJPY','EURJPY','AUDUSD','USDCHF','EURUSD-OTC','GBPUSD-OTC','USDJPY-OTC','EURJPY-OTC'];
const expiries=[1,2,3,5,10,15,30], feed=new Map(), viewers=new Set();
const STALE=2500; let lastEvent=null;
const now=()=>Date.now();
function status(id){const x=feed.get(id),t=now(),fresh=Boolean(x&&t-x.received<STALE),otc=id.endsWith('-OTC');
 const signals=expiries.map(expiry=>({expiry,signal:null,status:!fresh?'SEM COTAÇÃO':'VALIDAÇÃO PENDENTE',payout:null,reason:'Sem candles, payout e resultado auditados para este vencimento'}));
 return {id,name:id.replace('-OTC',' OTC').replace(/^(.{3})(.{3})/,'$1/$2'),type:otc?'OTC':'FOREX',price:fresh?x.price:null,lastObservedAt:x?new Date(x.received).toISOString():null,fresh,signals};
}
function snapshot(){const pairs=ids.map(status),active=pairs.filter(x=>x.fresh).length;return {app:'Radar OB',version:'5.1.0',broker:'IQ Option',sourceVerified:false,connectedAssets:active,scannedAssets:pairs.length,scenarios:ids.length*expiries.length,expiries,pairs,candidates:[],lastUpdated:lastEvent,activeViewers:viewers.size,notice:'NENHUM SINAL VALIDADO — aguardando fonte IQ Option, payout e verificação do preço executável.'};}
function send(res,name,obj){if(!res.destroyed)res.write('event: '+name+'\ndata: '+JSON.stringify(obj)+'\n\n');}
function broadcast(name,obj){for(const res of viewers){try{send(res,name,obj)}catch{viewers.delete(res)}}}
function response(res,code,obj){const s=JSON.stringify(obj);res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(s)}
function authorized(req){const s=process.env.INGEST_TOKEN||'',h=(req.headers.authorization||'').replace(/^Bearer /,'');return s.length>=32&&h.length===s.length&&crypto.timingSafeEqual(Buffer.from(s),Buffer.from(h))}
function bodyJSON(req){return new Promise((ok,fail)=>{let b='',n=0;req.on('data',v=>{n+=v.length;if(n>150000){req.destroy();fail(Error('Payload excede limite'))}else b+=v});req.on('end',()=>{try{ok(JSON.parse(b))}catch{fail(Error('JSON inválido'))}});req.on('error',fail)})}
function onStream(req,res){res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store, no-transform','connection':'keep-alive','x-accel-buffering':'no'});res.write('retry: 1800\n\n');viewers.add(res);send(res,'snapshot',snapshot());const timer=setInterval(()=>{if(!res.destroyed)res.write(': keepalive\n\n')},15000);const cleanup=()=>{clearInterval(timer);viewers.delete(res)};req.on('close',cleanup);res.on('close',cleanup);}
const files={'/':'index.html','/index.html':'index.html','/manifest.webmanifest':'manifest.webmanifest','/sw.js':'sw.js','/icon.svg':'icon.svg','/core.js':'core.js','/forex.js':'forex.js'};
const types={'.html':'text/html; charset=utf-8','.js':'application/javascript','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
http.createServer(async(req,res)=>{
 const u=new URL(req.url,'http://localhost');
 if(req.method==='GET'&&u.pathname==='/api/health')return response(res,200,{ok:true,version:'6.0.0',viewers:viewers.size,feedVerified:false});
 if(req.method==='GET'&&u.pathname==='/api/state')return response(res,200,snapshot());
 if(req.method==='GET'&&u.pathname==='/api/stream')return onStream(req,res);
 if(req.method==='POST'&&u.pathname==='/api/tick'){
  if(!authorized(req))return response(res,401,{error:'Não autorizado'});
  try{
    const b=await bodyJSON(req);
    if(!b||b.source!=='IQ Option'||!ids.includes(b.asset)||typeof b.price!=='number'||!Number.isFinite(b.price)||b.price<=0||!Number.isInteger(b.timestamp))throw Error('Tick inválido');
    const age=now()-b.timestamp*1000;if(age>5000||age< -1500)throw Error('Tick atrasado ou com data futura');
    feed.set(b.asset,{price:b.price,received:now(),at:b.timestamp});lastEvent=new Date().toISOString();
    broadcast('asset',{pair:status(b.asset),lastUpdated:lastEvent});return response(res,202,{ok:true});
  }catch(e){return response(res,400,{error:e.message})}
 }
 if(req.method!=='GET')return response(res,405,{error:'Método não permitido'});
 const f=files[u.pathname];if(!f)return response(res,404,{error:'Não encontrado'});
 fs.readFile(path.join(ROOT,f),(err,data)=>{if(err)return response(res,404,{error:'Arquivo não encontrado'});res.writeHead(200,{'content-type':types[path.extname(f)],'cache-control':f==='sw.js'?'no-cache':'public, max-age=120','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' wss://api.derivws.com wss://ws.binaryws.com; object-src 'none'; base-uri 'none'"});res.end(data)});
}).listen(PORT,'0.0.0.0',()=>process.stdout.write('Radar OB escutando porta '+PORT+'\n'));
