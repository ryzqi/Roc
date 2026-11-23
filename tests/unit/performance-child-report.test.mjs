import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readChildReport} from '../../scripts/performance/child-report.mjs';

test('child report reads preserve complete, missing and truncated output without masking the original failure', () => {
  const root=mkdtempSync(join(tmpdir(),'roc-child-report-'));
  try {
    const path=join(root,'sample.json');
    assert.deepEqual(readChildReport(path),{report:null});
    const value={kind:'fixture',scenarios:[{id:'completed-scene'}]};
    writeFileSync(path,JSON.stringify(value));
    assert.deepEqual(readChildReport(path),{report:value});
    const truncated='{"kind":"fixture","scenarios":[';
    writeFileSync(path,truncated);
    const result=readChildReport(path);
    assert.equal(result.report,null);
    assert.match(result.reportReadError,/SyntaxError/u);
    assert.equal(result.unparsedReport,truncated);
    writeFileSync(path,'null');
    assert.deepEqual(readChildReport(path),{report:null});
  } finally {rmSync(root,{recursive:true,force:true});}
});
