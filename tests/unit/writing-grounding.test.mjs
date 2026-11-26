import {test} from 'node:test';
import assert from 'node:assert/strict';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {unknownExperiment} from './fixtures/research-test-kit.mjs';
const {checkWritingClaim} = await importTypeScriptModule('src/main/plugins/research/writing-grounding.ts', {platform:'node',tempDir:'.runtime/tmp'});

test('grounding compares literal quantities including compute, SI prefixes, rates and scientific notation', () => {
  for (const [source,content,expected] of [
    ['Runtime is 10 s.','Cost is 10 FLOPs.','unit_mismatch'],
    ['Storage is 10 MB.','Storage is 10 mB.','unit_mismatch'],
    ['Throughput is 10 tokens/s.','Throughput is 10 tokens/h.','unit_mismatch'],
    ['Runtime is 1e3 ms.','Runtime is 1e3 ms.',null],
    ['Runtime is 1e3 ms.','Runtime is 1 s.','numeric_mismatch'],
    ['Cost is 10 GFLOPs.','Cost is 10 GFLOPs.',null],
    ['Length is 10 nm.','Length is 10 nm.',null],
    ['Time is 10 milliseconds.','Time is 10 FLOPs.','unit_mismatch'],
    ['结果为90。','结果为99。','numeric_mismatch'],
    ['耗时90毫秒。','耗时90秒并完成。','unit_mismatch'],
    ['耗时90秒。','耗时90秒并完成。',null],
    ['Area was 10 m².','Volume was 10 m³.','unit_mismatch'],
    ['Pressure was 10 psi.','Concentration was 10 ppm.','unit_mismatch'],
    ['Density was 10 kg/m³.','Density was 10 kg/m².','unit_mismatch'],
    ['Density was 10 kg m^-3.','Density was 10 kg m^-2.','unit_mismatch'],
    ['Density was 10 kg·m⁻³.','Density was 10 kg·m⁻³.',null],
    ['Rate was 10 s−1.','Rate was 10 s−2.','unit_mismatch'],
    ['Rate was 10 unknownUnits.','Rate was 10 otherUnits.','unit_mismatch']
  ]) {
    const repository = {evidence:{inspectEvidence:()=>({referenceStatus:'recorded',evidence:{excerpt:source}}),
      assertReviewedSupport:()=>{},relations:{list:()=>[]}}};
    const claim = {id:'claim',projectId:'project',artifactId:'draft',evidenceIds:['evidence'],content,experiment:unknownExperiment};
    const receipt = {result:{originalEvidenceIds:['evidence']},facts:[],bindings:[]};
    const issues = checkWritingClaim(repository,claim,receipt,{}).filter(issue=>['unit_mismatch','numeric_mismatch'].includes(issue.code));
    assert.deepEqual(issues.map(issue=>issue.code),expected?[expected]:[],`${source} -> ${content}`);
    if(expected) assert.match(content.slice(issues[0].span.start,issues[0].span.end),/\d/);
  }
});

test('structured experiment value and unit must share one original quantity or verified fact', () => {
  for(const unit of ['kg','ms']) {
    const source='Dataset C F1 Baseline A matched. Runtime 90 ms; mass 2 kg.';
    const repository={evidence:{inspectEvidence:()=>({referenceStatus:'recorded',evidence:{excerpt:source}}),
      assertReviewedSupport:()=>{},relations:{list:()=>[]}}};
    const claim={id:'claim',projectId:'project',artifactId:'draft',evidenceIds:['evidence'],content:'Reported measurements under matched conditions.',
      experiment:{...unknownExperiment,value:90,unit,dataset:'Dataset C',metric:'F1',baseline:'Baseline A',conditions:'matched'}};
    const issues=checkWritingClaim(repository,claim,{result:{originalEvidenceIds:['evidence']},facts:[],bindings:[]},{});
    assert.deepEqual(issues.map(issue=>issue.code),unit==='kg'?['unit_mismatch']:[]);
  }
});
