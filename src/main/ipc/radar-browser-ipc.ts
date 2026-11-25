import {session, WebContentsView, type BrowserWindow, type IpcMainInvokeEvent, type WebContents} from 'electron';
import {radarBrowserRequestSchema,radarBrowserResultSchema} from '../../shared/schemas/research-reading';
import {ipcChannels} from '../../shared/ipc';
import {logWarn,RocDomainError,wrapIpc} from '../services/errors';
import type {TimedHandle} from './ipc-common';
const origins={cool:'https://papers.cool',modelscope:'https://modelscope.cn'} as const;
const initialUrls={cool:`${origins.cool}/arxiv/cs.AI`,modelscope:`${origins.modelscope}/papers`} as const;

function navigationFailure(source:keyof typeof origins,error:unknown):RocDomainError {
  const code=error instanceof Error?/ERR_[A-Z0-9_]+/u.exec(error.message)?.[0]??'ERR_FAILED':'ERR_FAILED';
  const detail=code==='ERR_CONNECTION_CLOSED'?'网站连接已关闭':
    code==='ERR_NAME_NOT_RESOLVED'?'无法解析网站地址':
    code==='ERR_INTERNET_DISCONNECTED'?'网络连接已断开':
    code==='ERR_TIMED_OUT'||code==='ERR_CONNECTION_TIMED_OUT'?'网站连接超时':
    code.startsWith('ERR_CERT_')?'网站证书验证失败':'网页连接失败';
  logWarn('Radar webpage failed to load.',{service:'research',component:'radar-browser',metadata:{source,code}});
  return new RocDomainError({code:'radar_browser_load_failed',category:'external',
    message:`${source==='cool'?'Cool Papers':'魔搭论文'} 无法打开：${detail}。请检查网络或代理后刷新重试。`,
    retryable:!code.startsWith('ERR_CERT_'),userAction:'检查网络或代理后点击“刷新网页”重试。'});
}

/** reload/goBack return void; their IPC receipt still needs the real navigation outcome. */
function waitForNavigation(contents:WebContents,start:()=>Promise<void>|void):Promise<void> {
  return new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(error?:unknown):void=>{
      if(settled)return;settled=true;clearTimeout(timeout);
      contents.off('did-finish-load',loaded);contents.off('did-fail-load',failed);contents.off('destroyed',destroyed);
      if(error===undefined)resolve();else reject(error);
    };
    const loaded=():void=>finish();
    const failed=(_event:Electron.Event,_code:number,description:string,_url:string,isMainFrame:boolean):void=>{
      if(isMainFrame)finish(new Error(description));
    };
    const destroyed=():void=>finish(new Error('ERR_ABORTED'));
    const timeout=setTimeout(()=>{
      finish(new Error('ERR_TIMED_OUT'));
      if(!contents.isDestroyed())contents.stop();
    },30_000);
    contents.once('did-finish-load',loaded);contents.on('did-fail-load',failed);contents.once('destroyed',destroyed);
    try{const started=start();if(started)void started.then(loaded,error=>finish(error));}
    catch(error){finish(error);}
  });
}

/** External sites have no preload, no Node and a separate ephemeral session. */
export function registerRadarBrowserIpc(timedHandle:TimedHandle,mainWindow:BrowserWindow):void {
  let view:WebContentsView|null=null, source:keyof typeof origins|null=null;
  let failure:RocDomainError|null=null,pendingNavigation:Promise<void>|null=null,lastUrl='',navigationRevision=0,wantedVisible=false;
  const partition=`radar-${mainWindow.id}`,radarSession=session.fromPartition(partition);
  radarSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  radarSession.setPermissionCheckHandler(()=>false);
  const preventDownload=(event:Electron.Event):void=>event.preventDefault();
  radarSession.on('will-download',preventDownload);
  const close=():void=>{
    navigationRevision++;failure=null;pendingNavigation=null;lastUrl='';wantedVisible=false;
    if(view){mainWindow.contentView.removeChildView(view);if(!view.webContents.isDestroyed())view.webContents.close();view=null;source=null;}
  };
  const navigate=(owned:WebContentsView,ownedSource:keyof typeof origins,url:string,start:()=>Promise<void>|void):Promise<void>=>{
    const revision=++navigationRevision;failure=null;lastUrl=url;
    const operation=(async()=>{
      try{await waitForNavigation(owned.webContents,start);}
      catch(error){
        if(owned!==view||owned.webContents.isDestroyed()||revision!==navigationRevision||
          (error instanceof Error&&error.message.includes('ERR_ABORTED')))return;
        failure=navigationFailure(ownedSource,error);owned.setVisible(false);throw failure;
      }
      if(owned===view&&revision===navigationRevision)owned.setVisible(wantedVisible);
    })();
    pendingNavigation=operation;
    const clear=():void=>{if(pendingNavigation===operation)pendingNavigation=null;};
    void operation.then(clear,clear);
    return operation;
  };
  mainWindow.once('closed',()=>{navigationRevision++;if(view&&!view.webContents.isDestroyed())view.webContents.close();view=null;radarSession.off('will-download',preventDownload);});
  mainWindow.webContents.on('did-start-navigation',details=>{if(details.isMainFrame&&!details.isSameDocument)close();});
  timedHandle(ipcChannels.researchRadarBrowser,(event:unknown,raw:unknown)=>wrapIpc(async()=>{
    const sender=event as IpcMainInvokeEvent;
    if(sender.sender!==mainWindow.webContents || sender.senderFrame!==mainWindow.webContents.mainFrame)throw new Error('无效的雷达窗口。');
    const input=radarBrowserRequestSchema.parse(raw);
    if(input.action==='hide'){if(source===input.source){wantedVisible=false;view?.setVisible(false);}return {url:view?.webContents.getURL()??'',papers:[]};}
    let loading:Promise<void>|null=null;
    if(input.action==='open' && (!view || source!==input.source)){
      close();source=input.source;
      view=new WebContentsView({webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,partition}});
      const owned=view,contents=view.webContents;
      const permitted=(raw:string):boolean=>{try{const url=new URL(raw);return url.origin===origins[input.source]&&
        (input.source==='cool'||/^\/papers(?:\/|$)/u.test(url.pathname));}catch{return false;}};
      contents.setWindowOpenHandler(({url})=>{if(permitted(url))void navigate(owned,input.source,url,()=>contents.loadURL(url)).catch(()=>{});return {action:'deny'};});
      contents.on('will-navigate',(event,url)=>{if(!permitted(url))event.preventDefault();});
      contents.on('will-redirect',(event,url)=>{if(!permitted(url))event.preventDefault();});
      contents.on('did-start-navigation',details=>{if(owned===view&&details.isMainFrame&&!details.isSameDocument&&permitted(details.url))lastUrl=details.url;});
      mainWindow.contentView.addChildView(view);
      view.setVisible(false);
      loading=navigate(view,input.source,initialUrls[input.source],()=>contents.loadURL(initialUrls[input.source]));
    }
    if(!view || source!==input.source)return {url:'',papers:[]};
    const bounds=mainWindow.getContentBounds();
    view.setBounds({x:Math.min(input.bounds.x,bounds.width),y:Math.min(input.bounds.y,bounds.height),
      width:Math.max(0,Math.min(input.bounds.width,bounds.width-input.bounds.x)),height:Math.max(0,Math.min(input.bounds.height,bounds.height-input.bounds.y))});
    const owned=view;
    if(input.action==='open'||input.action==='bounds'){
      wantedVisible=input.bounds.width>0&&input.bounds.height>0;view.setVisible(wantedVisible&&failure===null);
    }
    if(input.action==='open'&&!loading&&failure){
      const url=lastUrl||initialUrls[input.source];
      loading=navigate(owned,input.source,url,()=>owned.webContents.loadURL(url));
    }
    if(input.action==='back'&&owned.webContents.navigationHistory.canGoBack()){
      const history=owned.webContents.navigationHistory;
      const url=history.getEntryAtIndex(history.getActiveIndex()-1)?.url??lastUrl;
      loading=navigate(owned,input.source,url,()=>history.goBack());
    }
    if(input.action==='reload'){
      const url=lastUrl||owned.webContents.getURL()||initialUrls[input.source],retry=failure!==null||!owned.webContents.getURL();
      loading=navigate(owned,input.source,url,()=>retry?owned.webContents.loadURL(url):owned.webContents.reload());
    }
    if(input.action!=='inspect'){
      if(loading)await loading;else if(input.action!=='bounds'&&pendingNavigation)await pendingNavigation;
      if(owned!==view||owned.webContents.isDestroyed())return {url:'',papers:[]};
      if(failure)throw failure;
      return {url:owned.webContents.getURL(),papers:[]};
    }
    wantedVisible=false;
    owned.setVisible(false);
    if(pendingNavigation)await pendingNavigation;
    if(owned!==view||owned.webContents.isDestroyed())return {url:'',papers:[]};
    if(failure)throw failure;
    const value:unknown=await owned.webContents.executeJavaScript(`(() => {
      const papers = new Map();
      for (const anchor of document.querySelectorAll('a[href]')) {
        let url; try { url = new URL(anchor.getAttribute('href'), location.href); } catch { continue; }
        const arxiv = url.hostname === 'arxiv.org' ? /^\\/(?:abs|pdf)\\/(.+?)(?:\\.pdf)?$/.exec(url.pathname)?.[1]
          : url.hostname === 'papers.cool' ? /^\\/arxiv\\/(\\d{4}\\.\\d{4,5}(?:v\\d+)?)$/.exec(url.pathname)?.[1]
          : url.hostname === 'modelscope.cn' ? /^\\/papers\\/(\\d{4}\\.\\d{4,5}(?:v\\d+)?)$/.exec(url.pathname)?.[1] : null;
        const doi = ['doi.org','dx.doi.org'].includes(url.hostname) ? url.pathname.slice(1) : null;
        if (!arxiv && !doi) continue;
        const card=anchor.closest('.paper,article,[data-paper-id]');
        const tracked = new URLSearchParams(anchor.getAttribute('data-autolog') || '').get('c4');
        const trackedTitle = url.hostname === 'modelscope.cn' && tracked && /^[0-9]+\\//.test(tracked) ? tracked.slice(tracked.indexOf('/') + 1) : '';
        const title = (trackedTitle || card?.querySelector('.title-link')?.textContent || card?.querySelector('h1,h2,h3,.title')?.textContent || anchor.querySelector('h1,h2,h3,[class*="title"],[class*="Title"]')?.textContent || anchor.getAttribute('title') || anchor.innerText?.trim().split('\\n')[0] || '').trim().slice(0,2000) || document.title.slice(0,2000);
        const key = arxiv || doi;
        if (!papers.has(key) || papers.get(key).title.length < title.length)
          papers.set(key,{title,url:arxiv?'https://arxiv.org/abs/'+arxiv:url.href,arxivId:arxiv||null,doi:doi||null});
      }
      return {url:location.href,papers:[...papers.values()].slice(0,100)};
    })()`);
    return radarBrowserResultSchema.parse(value);
  }));
}
