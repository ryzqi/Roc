import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
const {extractResearchRegionContent} = await importTypeScriptModule('src/main/plugins/research/document-parser.ts', {
  platform:'node', external:['@napi-rs/canvas','onnxruntime-node','paddleocr','pdfjs-dist/legacy/build/pdf.mjs'],tempDir:'.runtime/tmp'
});
// Captured from the locked complete model pack on tests/smoke/lib/assets/p5-paper.pdf.
const region=JSON.parse(readFileSync('tests/fixtures/research-table-region.json','utf8'));
test('SLANet wide-table cells are matched in crop coordinates and published as a filled Markdown table', () => {
  const before=JSON.stringify(region);const result=extractResearchRegionContent(region);
  assert.equal(result.text,'| Method | Accuracy | F1 |\n| --- | --- | --- |\n| Baseline | 0.812 | 0.804 |\n| Ours | 0.897 | 0.891 |');
  assert.deepEqual(result.table.matched.cellTexts,['Method','Accuracy','F1','Baseline','0.812','0.804','Ours','0.897','0.891']);
  assert.ok(result.table.structure.bbox.every(box=>box.filter((_,i)=>i%2===1).every(y=>y<=90)));
  assert.equal(JSON.stringify(region),before);
});
test('empty structure cannot hide recognized table text when matching is unavailable', () => {
  const result=extractResearchRegionContent({type:'table',table:{structure:{html:'<tr><td></td></tr>'},ocr:[{text:'Cell text'}]}});
  assert.equal(result.text,'Cell text');
  assert.equal(extractResearchRegionContent({type:'table',table:{structure:{html:'<tr><td></td></tr>'}}}).text,'');
});
test('recognized formulas retain their exact model output', () => {
  const formula=String.raw`\frac{1}{N}\sum_{i=1}^{N}(y_i-f_\theta(x_i))^2`;
  assert.equal(extractResearchRegionContent({type:'formula',formula:{formula}}).text,formula);
});
