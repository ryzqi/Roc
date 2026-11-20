import {session, WebContentsView, type BrowserWindow, type IpcMainInvokeEvent} from 'electron';
import {radarBrowserRequestSchema,radarBrowserResultSchema} from '../../shared/schemas/research-reading';
import {ipcChannels} from '../../shared/ipc';
import {wrapIpc} from '../services/errors';
import type {TimedHandle} from './ipc-common';
const origins={cool:'https://papers.cool',modelscope:'https://modelscope.cn'} as const;
/** External sites have no preload, no Node and a separate ephemeral session. */
export function registerRadarBrowserIpc(timedHandle:TimedHandle,mainWindow:BrowserWindow):void {
  let view:WebContentsView|null=null, source:keyof typeof origins|null=null;
  const partition=`radar-${mainWindow.id}`,radarSession=session.fromPartition(partition);
  radarSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  radarSession.setPermissionCheckHandler(()=>false);
  const preventDownload=(event:Electron.Event):void=>event.preventDefault();
  radarSession.on('will-download',preventDownload);
  const close=():void=>{if(view){mainWindow.contentView.removeChildView(view);view.webContents.close();view=null;source=null;}};
  mainWindow.once('closed',()=>{view?.webContents.close();view=null;radarSession.off('will-download',preventDownload);});
  mainWindow.webContents.on('did-start-navigation',details=>{if(details.isMainFrame&&!details.isSameDocument)close();});
  timedHandle(ipcChannels.researchRadarBrowser,(event:unknown,raw:unknown)=>wrapIpc(async()=>{
    const sender=event as IpcMainInvokeEvent;
    if(sender.sender!==mainWindow.webContents || sender.senderFrame!==mainWindow.webContents.mainFrame)throw new Error('无效的雷达窗口。');
    const input=radarBrowserRequestSchema.parse(raw);
    if(input.action==='hide'){if(source===input.source)view?.setVisible(false);return {url:view?.webContents.getURL()??'',papers:[]};}
    let loading:Promise<void>|null=null;
    if(input.action==='open' && (!view || source!==input.source)){
      close();source=input.source;
      view=new WebContentsView({webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,partition}});
      const contents=view.webContents;
      const permitted=(raw:string):boolean=>{try{const url=new URL(raw);return url.origin===origins[input.source]&&
        (input.source==='cool'||/^\/papers(?:\/|$)/u.test(url.pathname));}catch{return false;}};
      contents.setWindowOpenHandler(({url})=>{if(permitted(url))void contents.loadURL(url).catch(()=>{});return {action:'deny'};});
      contents.on('will-navigate',(event,url)=>{if(!permitted(url))event.preventDefault();});
      contents.on('will-redirect',(event,url)=>{if(!permitted(url))event.preventDefault();});
      mainWindow.contentView.addChildView(view);
      view.setVisible(false);
      loading=contents.loadURL(`${origins[input.source]}${input.source==='modelscope'?'/papers':'/arxiv/cs.AI'}`);
    }
    if(!view || source!==input.source)return {url:'',papers:[]};
    const bounds=mainWindow.getContentBounds();
    view.setBounds({x:Math.min(input.bounds.x,bounds.width),y:Math.min(input.bounds.y,bounds.height),
      width:Math.max(0,Math.min(input.bounds.width,bounds.width-input.bounds.x)),height:Math.max(0,Math.min(input.bounds.height,bounds.height-input.bounds.y))});
    if(input.action==='open'||input.action==='bounds')view.setVisible(input.bounds.width>0&&input.bounds.height>0);
    if(input.action==='back'&&view.webContents.navigationHistory.canGoBack())view.webContents.navigationHistory.goBack();
    if(input.action==='reload')view.webContents.reload();
    const owned=view;
    if(input.action!=='inspect'){if(loading)await loading;return {url:owned.webContents.isDestroyed()?'':owned.webContents.getURL(),papers:[]};}
    owned.setVisible(false);
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
