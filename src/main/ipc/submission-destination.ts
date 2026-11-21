export type SubmissionDestinationPicker = (windowId:number)=>Promise<string|null>;

export const pickSubmissionDestination:SubmissionDestinationPicker=async windowId=>{
  const {BrowserWindow,webContents,dialog}=await import('electron');
  const sender=webContents.fromId(windowId);
  if(sender===undefined)throw new Error('research_submission_window_required');
  const window=BrowserWindow.fromWebContents(sender);
  if(window===null||window.isDestroyed())throw new Error('research_submission_window_required');
  const result=await dialog.showSaveDialog(window,{title:'保存投稿包',buttonLabel:'保存',defaultPath:'submission.zip',
    filters:[{name:'ZIP 投稿包',extensions:['zip']}]});
  if(window.isDestroyed()||sender.isDestroyed())throw new Error('research_submission_window_required');
  return result.canceled||result.filePath===undefined?null:result.filePath;
};
