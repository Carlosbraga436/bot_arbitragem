'use strict';
/* Radar OB Mobile — servidor de arquivos somente-leitura.
   Cotações e análise acontecem no navegador pelo WebSocket público da Deriv.
   Nenhuma credencial, execução de ordens, ingestão de ticks ou conexão IQ Option. */
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const PORT=Number(process.env.PORT||3000);
const root=__dirname;
const files={
  '/':'index.html','/index.html':'index.html',
  '/core.js':'core.js','/forex.js':'forex.js',
  '/manifest.webmanifest':'manifest.webmanifest',
  '/sw.js':'sw.js','/icon.svg':'icon.svg'
};
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8',
  '.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
const csp=["default-src 'self'","script-src 'self' 'unsafe-inline'","style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:","connect-src 'self' wss://api.derivws.com wss://ws.binaryws.com",
  "object-src 'none'","base-uri 'none'","frame-ancestors 'none'"].join('; ');
function json(res,status,body){
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));
}
const server=http.createServer((req,res)=>{
  let uri;try{uri=new URL(req.url,'http://localhost')}catch(_){return json(res,400,{error:'URI inválida'})}
  if(req.method!=='GET')return json(res,405,{error:'Método não permitido'});
  if(uri.pathname==='/api/health')return json(res,200,{ok:true,version:'6.0.0',source:'Deriv public WebSocket (client-side)',realTimeFeedVerified:false,iqOptionConnected:false});
  if(uri.pathname==='/api/state')return json(res,200,{ok:true,version:'6.0.0',mode:'browser-on-demand',source:'Deriv Forex',sourceType:'external',iqOptionConnected:false,notice:'Os dados e sinais são calculados no navegador enquanto o aplicativo está aberto.'});
  const filename=files[uri.pathname];if(!filename)return json(res,404,{error:'Rota não encontrada'});
  fs.readFile(path.join(root,filename),(err,data)=>{
    if(err)return json(res,404,{error:'Arquivo não encontrado'});
    res.writeHead(200,{'Content-Type':types[path.extname(filename)]||'application/octet-stream',
      'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Content-Security-Policy':csp,
      'Referrer-Policy':'no-referrer'});
    res.end(data);
  });
});
if(require.main===module)server.listen(PORT,'0.0.0.0',()=>console.log('Radar OB Forex V6 escutando porta '+PORT));
module.exports={server};
