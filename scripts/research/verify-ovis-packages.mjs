/** Actual offline installation of all pinned wheels under the production supervisor. */
import assert from 'node:assert/strict';
import {constants} from 'node:fs';
import {copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {importTypeScriptModule} from '../lib/bundle-ts.mjs';

const {values} = parseArgs({options: {output: {type: 'string'}}, strict: true});
if (!values.output) throw new Error('--output required');
const output = resolve(values.output); await mkdir(output);
const {ResearchPythonRuntimeStore} = await importTypeScriptModule('src/main/plugins/research/python-runtime-store.ts', {platform: 'node'});
const {ovisDownloadAssets, withOvisDownloads} = await importTypeScriptModule('src/main/plugins/research/ovis-downloads.ts', {platform: 'node'});
const {installOvisPackages} = await importTypeScriptModule('src/main/plugins/research/ovis-package-installer.ts', {platform: 'node'});
const {runSupervisedResearchProcess} = await importTypeScriptModule('src/main/plugins/research/process-supervision.ts', {platform: 'node'});
const {runPythonInstallerProcess} = await importTypeScriptModule('src/main/plugins/research/python-installer-process.ts', {platform: 'node'});
const {downloadVerified, fileSha256} = await importTypeScriptModule('scripts/research/download-asset.ts', {platform: 'node'});
const {runResearchProcess} = await importTypeScriptModule('src/main/plugins/research/process-runner.ts', {platform: 'node'});
const root = await realpath(await mkdtemp('/private/tmp/roc-ovis-package-check-'));
const report = {status: 'running', scope: 'Actual pinned offline wheel installation, cancellation and tamper rejection; no conversion or parser adoption',
  phases: [], checks: [], ownedDirectoriesRemoved: false, installerSha256: await fileSha256('src/main/plugins/research/ovis-package-installer.ts')};
let safeToClean = true;
const unprovenExit = error => ['research_process_completion_failed', 'research_process_kill_failed',
  'research_process_supervision_failed'].includes(error?.code);
try {
  const runtime = await new ResearchPythonRuntimeStore(join(root, 'python-tools'), runPythonInstallerProcess,
    async (url, hash, target, options) => {
      const archive = resolve('.runtime/research-toolchain-p2-probe', url.endsWith('uv-aarch64-apple-darwin.tar.gz') ? 'uv.tar.gz' : 'python.tar.gz');
      await copyFile(archive, target, constants.COPYFILE_EXCL);
      return await downloadVerified(url, hash, target, options);
    }).prepare('3.14.10', 'ovis-package-check', new AbortController().signal);
  const requirements = await realpath('resources/ovis-ocr/requirements.lock');
  const assets = ovisDownloadAssets().filter(asset => asset.path.startsWith('wheels/'));
  await withOvisDownloads({parent: root, assets, signal: AbortSignal.timeout(600000)}, async bundle => {
    const destination = join(root, 'installed'); await mkdir(destination);
    const input = {runtime, destination, wheelhouse: join(bundle.root, 'wheels'), requirements,
      projectId: 'ovis-package-check', signal: new AbortController().signal,
      onPhase: phase => {report.phases.push(phase); console.log(phase);}};
    const installed = await installOvisPackages(input);
    assert.equal(Object.keys(installed.packages).length, 67);
    const probe = await runResearchProcess({command: runtime.executable,
      args: ['-I', '-S', '-B', '-X', 'utf8', '-c', `import sys,socket,subprocess,json
sys.path.insert(0,sys.argv[1])
import numpy, PIL, cv2
result={'numpy':numpy.__version__,'pillow':PIL.__version__,'opencv':cv2.__version__}
for name,fn in [('network',lambda:socket.create_connection(('1.1.1.1',443),1)),('shell',lambda:subprocess.run(['/bin/sh','-c','true'],check=True))]:
 try:fn();result[name]=False
 except OSError:result[name]=True
print(json.dumps(result))`, join(installed.runtime, 'lib/python3.14/site-packages')],
      cwd: destination, readablePaths: [runtime.prefix, installed.runtime, '/usr/lib', '/System/Library'], writablePaths: [],
      environment: {PATH: '/usr/bin:/bin'}, timeoutMs: 60000, resourceLimits: {mode: 'monitored', cpuTimeMs: 60000, maxResidentBytes: 1024 ** 3},
      admission: {projectId: 'ovis-package-check', resourceClass: 'utility', priority: 'user'}, allowGpuAcceleration: false,
      networkAccess: 'none', writeLimits: []});
    assert.equal(probe.exitCode, 0, probe.stderr);
    const imports = JSON.parse(probe.stdout); assert.equal(imports.network, true); assert.equal(imports.shell, true);
    report.checks.push({name: 'all-67-offline-wheels-and-native-imports', packages: installed.packages, operations: installed.operations, probe});
    await assert.rejects(installOvisPackages(input), /destination_invalid/);
    report.checks.push({name: 'existing-destination-preserved', passed: true});
    const cancelDestination = join(root, 'cancelled'); await mkdir(cancelDestination);
    const controller = new AbortController();
    let cancellationEvidence, cancellationError;
    try {
      await installOvisPackages({...input, destination: cancelDestination, signal: controller.signal}, async request => {
        if (request.args[0] !== 'pip') return await runSupervisedResearchProcess(request);
        let finished = false;
        const monitor = (async () => {
          while (!finished) {
            // Cancel only after uv has started writing installed packages. A timer
            // started before profile verification tests hash cancellation instead.
            const installedNames = await readdir(join(cancelDestination, 'runtime/lib/python3.14/site-packages'));
            if (installedNames.length) {cancellationEvidence = installedNames; controller.abort(); return;}
            await new Promise(resolve => setTimeout(resolve, 5));
          }
        })();
        try {return await runSupervisedResearchProcess(request);}
        finally {finished = true; await monitor;}
      });
    } catch (error) {if (unprovenExit(error)) throw error; cancellationError = error;}
    assert.equal(cancellationError?.code, 'research_process_cancelled');
    assert.ok(cancellationEvidence?.length);
    await rm(cancelDestination, {recursive: true});
    report.checks.push({name: 'cancelled-sync-supervised-and-cleaned', passed: true, cancellationEvidence});
    const corruptDestination = join(root, 'corrupt'); await mkdir(corruptDestination);
    const path = join(bundle.root, assets[0].path), original = await readFile(path); await writeFile(path, Buffer.alloc(original.length));
    await assert.rejects(installOvisPackages({...input, destination: corruptDestination}, async () => assert.fail('executed corrupt wheel')),
      /integrity_failed/);
    report.checks.push({name: 'corrupt-wheel-refused-before-process', passed: true});
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = {message: error.message, code: error.code, cause: error.cause, stdout: error.stdout, stderr: error.stderr};
  safeToClean = !unprovenExit(error);
  process.exitCode = 1;
} finally {
  if (safeToClean) {await rm(root, {recursive: true}); report.ownedDirectoriesRemoved = true;} else report.retainedRoot = root;
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
  console.log(JSON.stringify({status: report.status, checks: report.checks.map(check => check.name), error: report.error}));
}
