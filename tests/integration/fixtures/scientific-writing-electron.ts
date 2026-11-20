import {app, BrowserWindow, nativeImage} from 'electron';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {ResearchDiagramService} from '../../../src/main/plugins/research/diagram-service';
import {researchContentHash} from '../../../src/main/plugins/research/research-files';

app.on('window-all-closed', () => {});
void app.whenReady().then(async () => {
const root = await realpath(await mkdtemp('/tmp/roc-scientific-diagram-'));
const source = 'flowchart LR\n A[Research question] --> B[Experiment]\n B --> C[Evidence review]';
const service = new ResearchDiagramService({getProject: () => ({id: 'p', workspacePath: root, status: 'active'})} as never);
try {
  await writeFile(join(root, 'method.mmd'), source);
  const output = await service.render({projectId: 'p', path: 'method.mmd'});
  assert.equal(output.files.length, 5);
  for (const file of output.files) assert.equal(researchContentHash(await readFile(join(root, output.directory, file.path))), file.sha256);
  const svg = await readFile(join(root, output.directory, 'diagram.svg'), 'utf8');
  assert.match(svg, /Research<.*question/su); assert.ok(!svg.includes('foreignObject'));
  assert.equal((await readFile(join(root, output.directory, 'diagram.pdf'))).subarray(0, 5).toString(), '%PDF-');
  const png = await readFile(join(root, output.directory, 'diagram.png'));
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  const bitmap = nativeImage.createFromBuffer(png).toBitmap();
  assert.ok(bitmap.some(byte => byte !== 255), 'PNG must contain the rendered diagram');
  await writeFile(join(root, 'unsafe.mmd'), 'flowchart LR\nclick A "https://example.com"');
  await assert.rejects(service.render({projectId: 'p', path: 'unsafe.mmd'}), /unsafe_source/);
  await writeFile(join(root, 'broken.mmd'), 'flowchart LR\nA[broken');
  await assert.rejects(service.render({projectId: 'p', path: 'broken.mmd'}));
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  console.log(JSON.stringify({status: 'passed', root, output}));
} catch (error) {console.error(error); process.exitCode = 1;}
finally {await service.shutdown(); app.exit(process.exitCode ?? 0);}

}).catch(error => {console.error(error); app.exit(1);});
