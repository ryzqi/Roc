import {app, BrowserWindow, nativeImage} from 'electron';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, realpath, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {ResearchDiagramService} from '../../../src/main/plugins/research/diagram-service';
import {researchContentHash} from '../../../src/main/plugins/research/research-files';

app.on('window-all-closed', () => {});
void app.whenReady().then(async () => {
const root = await realpath(await mkdtemp('/tmp/roc-scientific-diagram-'));
const diagrams = [
  {name: 'flowchart', label: 'Research', source: 'flowchart LR\n A[Research question] --> B[Experiment]\n B --> C[Evidence review]'},
  {name: 'flowchart-clusters', label: 'Review', source: 'flowchart LR\n subgraph Evidence\n A[Review] -->|Accepted| B{Decision}\n end\n B --> C((Publish))\n C --> A\n C --> C'},
  {name: 'graph', label: 'Legacy', source: 'graph LR\n A[Legacy graph] --> B[Evidence]'},
  {name: 'sequence', label: 'Alice', source: 'sequenceDiagram\n participant Alice\n participant Bob\n Alice->>Bob: Evidence review'},
  {name: 'state', label: 'Published', source: 'stateDiagram-v2\n [*] --> Review\n Review --> Published\n Published --> [*]'},
  {name: 'state-nested', label: 'Checked', source: 'stateDiagram-v2\n [*] --> Review\n state Review {\n [*] --> Draft\n Draft --> Checked\n }\n Review --> Published\n Published --> [*]'},
  {name: 'class', label: 'Evidence', source: 'classDiagram\n class Evidence {\n +String title\n }\n class Review\n Review --> Evidence'},
  {name: 'er', label: 'PAPER', source: 'erDiagram\n PROJECT ||--o{ PAPER : contains\n PROJECT {\n string name\n }\n PAPER {\n string title\n }'}
];
const service = new ResearchDiagramService({getProject: () => ({id: 'p', workspacePath: root, status: 'active'})} as never);
try {
  const rendered = [];
  for (const diagram of diagrams) {
    const path = `${diagram.name}.mmd`;
    await writeFile(join(root, path), diagram.source);
    const output = await service.render({projectId: 'p', path});
    assert.equal(output.files.length, 5);
    for (const file of output.files) assert.equal(researchContentHash(await readFile(join(root, output.directory, file.path))), file.sha256);
    const svg = await readFile(join(root, output.directory, 'diagram.svg'), 'utf8');
    assert.ok(svg.includes(diagram.label), `${diagram.name} SVG must contain its diagram content`);
    if (diagram.name === 'flowchart') assert.match(svg, /Research<.*question/su);
    assert.ok(!svg.includes('foreignObject'));
    assert.equal((await readFile(join(root, output.directory, 'diagram.pdf'))).subarray(0, 5).toString(), '%PDF-');
    const png = await readFile(join(root, output.directory, 'diagram.png'));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    const bitmap = nativeImage.createFromBuffer(png).toBitmap();
    assert.ok(bitmap.some(byte => byte !== 255), `${diagram.name} PNG must contain the rendered diagram`);
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    rendered.push({name: diagram.name, svgSha256: researchContentHash(Buffer.from(svg)), pngSha256: researchContentHash(png)});
  }
  await writeFile(join(root, 'unsafe.mmd'), 'flowchart LR\nclick A "https://example.com"');
  await assert.rejects(service.render({projectId: 'p', path: 'unsafe.mmd'}), /unsafe_source/);
  await writeFile(join(root, 'broken.mmd'), 'flowchart LR\nA[broken');
  await assert.rejects(service.render({projectId: 'p', path: 'broken.mmd'}));
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  console.log(JSON.stringify({status: 'passed', rendered}));
} catch (error) {console.error(error); process.exitCode = 1;}
finally {await service.shutdown(); await rm(root, {recursive: true, force: true}); app.exit(process.exitCode ?? 0);}

}).catch(error => {console.error(error); app.exit(1);});
