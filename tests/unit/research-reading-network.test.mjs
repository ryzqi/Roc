import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import {connect,isIP} from 'node:net';
import {syncBuiltinESMExports} from 'node:module';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {build} from 'esbuild';

const publicIp='93.184.216.34',nextIp='93.184.216.35';
const proxyKeys=['http_proxy','HTTP_PROXY','https_proxy','HTTPS_PROXY','no_proxy','NO_PROXY','NODE_USE_ENV_PROXY'];
let directory,api,key,cert;
before(async()=>{
 directory=mkdtempSync(join(tmpdir(),'roc-reading-network-'));
 const config=join(directory,'certificate.conf');
 writeFileSync(config,'[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=reading.example\n[ext]\nsubjectAltName=DNS:reading.example,DNS:next.example\n');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-config',config,
   '-keyout',join(directory,'key.pem'),'-out',join(directory,'cert.pem')],{stdio:'ignore'});
 key=readFileSync(join(directory,'key.pem'));cert=readFileSync(join(directory,'cert.pem'));
 const outfile=join(directory,'network.mjs');
 await build({entryPoints:['src/main/plugins/research/reading-network.ts'],outfile,bundle:true,
   format:'esm',platform:'node',packages:'external',logLevel:'silent'});
 api=await import(outfile);
});
after(()=>{if(directory)rmSync(directory,{recursive:true,force:true});});

async function network(t,handler){
 const connects=[],direct=[],requests=[],sockets=new Set();
 const addresses=new Map([
   ['reading.example',[{address:publicIp,family:4}]],
   ['next.example',[{address:nextIp,family:4}]],
   ['private.example',[{address:'10.0.0.1',family:4}]],
   ['mixed.example',[{address:publicIp,family:4},{address:'127.0.0.1',family:4}]]
 ]);
 const track=socket=>{sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));};
 const origin=https.createServer({key,cert},async(req,res)=>{
   let body='';for await(const chunk of req)body+=chunk;
   requests.push({url:req.url,method:req.method,host:req.headers.host,servername:req.socket.servername,body});
   handler(req,res);
 });
 const proxy=http.createServer();
 origin.on('connection',track);proxy.on('connection',track);
 proxy.on('connect',(req,client,head)=>{
   connects.push(req.url);
   const upstream=connect(origin.address().port,'127.0.0.1');track(upstream);
   upstream.once('connect',()=>{
     client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
     if(head.length)upstream.write(head);
     client.pipe(upstream);upstream.pipe(client);
   });
   client.once('close',()=>upstream.destroy());upstream.once('close',()=>client.destroy());
 });
 const savedEnv=Object.fromEntries(proxyKeys.map(name=>[name,process.env[name]]));
 const savedHttpAgent=http.globalAgent,savedHttpsAgent=https.globalAgent;
 t.after(async()=>{
   t.mock.restoreAll();syncBuiltinESMExports();
   http.globalAgent.destroy();https.globalAgent.destroy();
   http.globalAgent=savedHttpAgent;https.globalAgent=savedHttpsAgent;
   for(const name of proxyKeys){if(savedEnv[name]===undefined)delete process.env[name];else process.env[name]=savedEnv[name];}
   for(const socket of sockets)socket.destroy();
   await Promise.all([new Promise(resolve=>proxy.close(resolve)),new Promise(resolve=>origin.close(resolve))]);
 });
 await Promise.all([new Promise(resolve=>origin.listen(0,'127.0.0.1',resolve)),
   new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve))]);
 const proxyUrl=`http://127.0.0.1:${proxy.address().port}`;
 for(const name of ['http_proxy','HTTP_PROXY','https_proxy','HTTPS_PROXY'])process.env[name]=proxyUrl;
 process.env.NODE_USE_ENV_PROXY='1';process.env.no_proxy='';process.env.NO_PROXY='';
 http.setGlobalProxyFromEnv();
 const lookup=t.mock.method(dns,'lookup',async hostname=>{
   if(addresses.has(hostname))return addresses.get(hostname);
   if(isIP(hostname))return [{address:hostname,family:isIP(hostname)}];
   throw new Error(`Unexpected fixture DNS lookup: ${hostname}`);
 });
 // Only replace DNS and trust the disposable fixture certificate; the HTTPS
 // request, CONNECT tunnel, TLS verification and response streams remain real.
 const originalRequest=https.request,originalConnect=tls.connect;
 t.mock.method(https,'request',(url,options,callback)=>originalRequest(url,{...options,ca:cert},callback));
 t.mock.method(tls,'connect',(options,...args)=>{
   if(!options.socket&&['reading.example','next.example',publicIp,nextIp].includes(options.host)){
     let destination=options.host;
     if(!isIP(destination)&&options.lookup)
       options.lookup(destination,{all:true},(error,rows)=>{assert.equal(error,null);destination=rows[0].address;});
     direct.push({destination,servername:options.servername});
     return originalConnect({...options,host:'127.0.0.1',port:origin.address().port,lookup:undefined},...args);
   }
   return originalConnect(options,...args);
 });
 syncBuiltinESMExports();
 return {connects,direct,requests,addresses,proxy,lookup};
}

test('reading HTTPS uses the configured proxy after public DNS validation and retains original TLS identity',async t=>{
 const f=await network(t,(_req,res)=>res.end('fixture response'));
 assert.equal(await api.fetchReadingText('https://reading.example/feed?limit=1'),'fixture response');
 assert.deepEqual(f.connects,['reading.example:443'],'let the configured proxy resolve the original hostname');
 assert.equal(f.direct.length,0,'do not bypass the environment proxy');
 assert.deepEqual(f.requests,[{url:'/feed?limit=1',method:'GET',host:'reading.example',servername:'reading.example',body:''}]);
});

test('reading network rejects private or mixed DNS and revalidates redirect destinations',async t=>{
 const f=await network(t,(req,res)=>{
   res.writeHead(302,{Location:req.url==='/private'?'https://private.example/secret':
     req.url==='/mixed'?'https://mixed.example/secret':'http://next.example/feed'});res.end();
 });
 for(const url of ['https://127.0.0.1','https://private.example','https://mixed.example'])
   await assert.rejects(()=>api.fetchReadingText(url),/公开互联网/);
 assert.equal(f.requests.length,0);
 await assert.rejects(()=>api.fetchReadingText('https://reading.example/private'),/公开互联网/);
 await assert.rejects(()=>api.fetchReadingText('https://reading.example/mixed'),/公开互联网/);
 await assert.rejects(()=>api.fetchReadingText('https://reading.example/downgrade'),/HTTPS/);
 assert.equal(f.requests.length,3,'unsafe redirect destinations never receive a request');
});

test('proxied reading requests verify the original hostname against the server certificate',async t=>{
 const f=await network(t,(_req,res)=>res.end('must not be read'));
 f.addresses.set('untrusted.example',[{address:publicIp,family:4}]);
 await assert.rejects(()=>api.fetchReadingText('https://untrusted.example/feed'),
   error=>error.code==='ERR_TLS_CERT_ALTNAME_INVALID');
 assert.equal(f.requests.length,0);
});

test('reading redirects validate each destination and enforce redirect, credential and response limits',async t=>{
 const f=await network(t,(req,res)=>{
   if(req.url==='/final'){res.end('redirected');return;}
   if(req.url==='/large'){res.end(Buffer.alloc(8_000_001));return;}
   if(req.url==='/missing'){res.writeHead(302);res.end();return;}
   res.writeHead(302,{Location:req.url==='/loop'?'/loop':'https://next.example/final'});res.end();
 });
 assert.equal(await api.fetchReadingText('https://reading.example/redirect'),'redirected');
 assert.deepEqual(f.connects,['reading.example:443','next.example:443']);
 await assert.rejects(()=>api.fetchReadingText('https://reading.example/loop'),/重定向次数/);
 await assert.rejects(()=>api.fetchReadingText('https://reading.example/missing'),/缺少目标地址/);
 await assert.rejects(()=>api.fetchReadingText('https://reading.example/redirect',{
   method:'POST',body:'fixture body',headers:{Authorization:'Bearer fixture-provider-key'}
 }),/翻译端点发生重定向/);
 assert.equal(f.requests.at(-1).body,'fixture body');
 await assert.rejects(()=>api.fetchReadingText('https://reading.example/redirect',{
   headers:{'Ocp-Apim-Subscription-Key':'fixture-provider-key'}
 }),/翻译端点发生重定向/);
 await assert.rejects(()=>api.fetchReadingText('https://reading.example/large'),/8 MB/);
});

test('proxy bypass honors NO_PROXY on the original hostname while direct TLS stays pinned',async t=>{
 const f=await network(t,(_req,res)=>res.end('direct response'));
 for(const bypass of ['reading.example','.reading.example','*.example','reading.example:443','*']){
   process.env.no_proxy=bypass;http.setGlobalProxyFromEnv();
   assert.equal(await api.fetchReadingText('https://reading.example/feed'),'direct response');
 }
 assert.equal(f.connects.length,0);assert.equal(f.direct.length,5);
 assert.ok(f.direct.every(row=>row.destination===publicIp&&row.servername==='reading.example'));
 process.env.NO_PROXY='reading.example';process.env.no_proxy='unrelated.example';http.setGlobalProxyFromEnv();
 assert.equal(await api.fetchReadingText('https://reading.example/feed'),'direct response');
 assert.deepEqual(f.connects,['reading.example:443'],'lowercase no_proxy takes precedence and nonmatching hosts use the proxy');
});

test('reading deadline reports a timeout and caller cancellation preserves its original reason',async t=>{
 let started;
 const entered=()=>new Promise(resolve=>{started=resolve;});
 await network(t,()=>started());
 const timeout=new AbortController();
 const timeoutMock=t.mock.method(AbortSignal,'timeout',()=>timeout.signal);
 let ready=entered();
 const expired=api.fetchReadingText('https://reading.example/stall');await ready;
 timeout.abort(new DOMException('The operation was aborted due to timeout','TimeoutError'));
 await assert.rejects(()=>expired,error=>error.name==='TimeoutError'&&/来源请求超时/.test(error.message));
 const freshTimeout=new AbortController();timeoutMock.mock.mockImplementation(()=>freshTimeout.signal);
 const caller=new AbortController(),reason=new DOMException('Fixture caller cancelled','AbortError');
 ready=entered();const cancelled=api.fetchReadingText('https://reading.example/stall',{signal:caller.signal});await ready;
 caller.abort(reason);await assert.rejects(()=>cancelled,error=>error===reason);
});

test('reading cancellation stops pending DNS and closes an unfinished CONNECT tunnel',async t=>{
 const f=await network(t,(_req,res)=>res.end('unused'));
 const pendingDns=Promise.withResolvers(),dnsStarted=Promise.withResolvers();
 f.lookup.mock.mockImplementation(()=>{dnsStarted.resolve();return pendingDns.promise;});
 const dnsCaller=new AbortController(),dnsReason=new DOMException('DNS cancelled','AbortError');
 const waiting=api.fetchReadingText('https://reading.example/feed',{signal:dnsCaller.signal});
 await dnsStarted.promise;dnsCaller.abort(dnsReason);
 try{
   await Promise.race([assert.rejects(()=>waiting,error=>error===dnsReason),
     delay(500).then(()=>{throw new Error('Cancellation did not stop pending DNS');})]);
 }finally{pendingDns.resolve([{address:publicIp,family:4}]);}
 f.lookup.mock.mockImplementation(async()=>[{address:publicIp,family:4}]);
 const opened=Promise.withResolvers(),closed=Promise.withResolvers();
 f.proxy.removeAllListeners('connect');
 f.proxy.on('connect',(_req,socket)=>{
   socket.once('close',()=>closed.resolve());socket.once('end',()=>socket.destroy());socket.resume();opened.resolve();
 });
 const caller=new AbortController(),reason=new DOMException('CONNECT cancelled','AbortError');
 const connecting=api.fetchReadingText('https://reading.example/feed',{signal:caller.signal});
 await opened.promise;caller.abort(reason);
 await Promise.race([assert.rejects(()=>connecting,error=>error===reason),
   delay(500).then(()=>{throw new Error('Cancellation waited for CONNECT establishment');})]);
 await Promise.race([closed.promise,delay(500).then(()=>{throw new Error('Cancelled CONNECT socket was retained');})]);
});
