import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {build} from 'esbuild';

const require = createRequire(import.meta.url);
const result = await build({
  stdin: {contents: `export {TerminalSessionService} from './src/main/services/terminal-session-service';
    export {withTerminalOwner} from './src/main/services/terminal-owner-context';`, resolveDir:process.cwd(), loader:'ts'},
  bundle:true, platform:'node', format:'esm', write:false, logLevel:'silent',
  plugins:[{name:'native-pty-location',setup(builder){builder.onResolve({filter:/^node-pty$/},()=>({path:pathToFileURL(require.resolve('node-pty')).href,external:true}));}}]
});
const {TerminalSessionService,withTerminalOwner} = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
async function until(read, message) {
  for (let attempt=0;attempt<400;attempt++) {if (read()) return; await delay(20);}
  assert.fail(message);
}

for (const finish of ['explicit close', 'window destroyed', 'application shutdown']) {
  test(`real PTY survives display detach, resumes ordered output and exits on ${finish}`, async t => {
    const directory = await mkdtemp(join(tmpdir(),'roc-terminal-reattach-'));
    const previousShell=process.env.SHELL;
    process.env.SHELL='/bin/sh';
    const service = new TerminalSessionService({terminalDir:directory},{
      requireWorkspace:()=>({path:directory}),isPathInsideCurrentWorkspace:path=>path===directory
    });
    t.after(async()=>{service.shutdown();if(previousShell===undefined)delete process.env.SHELL;else process.env.SHELL=previousShell;await rm(directory,{recursive:true,force:true});});
    const owner=55, request={projectId:'fixture',cwd:directory,cols:80,rows:24};
    const call=action=>withTerminalOwner(owner,action);
    const events=[];
    service.onOutput(event=>events.push(event));
    const first=call(()=>service.attachSession(request));
    const identity=attachment=>({projectId:'fixture',sessionId:attachment.session.id,attachmentId:attachment.attachmentId});
    call(()=>service.writeInput({...identity(first),data:"printf '\\nSHELL_PID=%s\\n' \"$$\"; printf '\\nFIRST_READY\\n'\r"}));
    await until(()=>events.map(event=>event.data).join('').includes('\r\nFIRST_READY\r\n'),'real shell did not start');
    const initialOutput=events.map(event=>event.data).join('');
    const pid=Number(initialOutput.match(/\r\nSHELL_PID=(\d+)\r\n/u)?.[1]);
    assert.ok(pid>0);
    call(()=>service.writeInput({...identity(first),data:"sleep 0.15; printf '\\nDETACHED_DONE\\n'\r"}));
    call(()=>service.detachSession(identity(first)));
    const before=events.length;
    await delay(250);
    process.kill(pid,0);
    assert.equal(events.length,before,'detached display receives no new events');
    const second=call(()=>service.attachSession(request));
    assert.equal(second.session.id,first.session.id);
    assert.match(second.replay.data,/\r\nDETACHED_DONE\r\n/u);
    assert.equal(second.replay.startSequence+second.replay.data.length,second.replay.sequence);
    call(()=>service.detachSession(identity(first)));
    call(()=>service.writeInput({...identity(second),data:"printf '\\nRESUMED_DONE\\n'\r"}));
    await until(()=>events.slice(before).map(event=>event.data).join('').includes('\r\nRESUMED_DONE\r\n'),'reattached real shell did not respond');
    const resumed=events.slice(before);
    assert.equal(resumed[0].startSequence,second.replay.sequence);
    for(let n=1;n<resumed.length;n++) assert.equal(resumed[n].startSequence,resumed[n-1].sequence);
    assert.ok(resumed.every(event=>event.attachmentId===second.attachmentId));
    if(finish==='explicit close')call(()=>service.closeSession(identity(second)));
    else if(finish==='window destroyed')service.closeOwner(owner);
    else service.shutdown();
    await until(()=>{try{process.kill(pid,0);return false;}catch(error){return error.code==='ESRCH';}},'PTY remained alive after terminal owner ended');
  });
}
