import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('formula measurement regions preserve raw evidence, ambiguous numbers and every denominator', () => {
  const result = spawnSync('python3', ['-B', '-c', `
import copy,importlib.util
spec=importlib.util.spec_from_file_location('regions','scripts/research/ovis-formula-regions.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
rule={'minimumNumberVerticalOverlap':.5,'distanceTieTolerance':1e-12}
g={'page_info':{'width':1000,'height':1000},'layout_dets':[
 {'category_type':'equation_isolated','poly':[100,200,900,200,900,250,100,250],'latex':'x tag1','order':3}]}
p=[{'category':'display_formula','bbox':[100,200,500,250],'content':'x'},
   {'category':'formula_number','bbox':[850,210,900,240],'content':'(1)'},
   {'category':'figure_title','bbox':[50,600,950,650],'content':'Figure 1'}]
original=copy.deepcopy((g,p))
a,b,links=m.measurement_regions(g,p,rule)
assert (g,p)==original
assert len(a['layout_dets'])==1 and len(b)==3
assert b[0]['bbox']==[100,200,900,250] and b[1:]==p[1:]
assert links['prediction']['pairs'][0]['numberIndex']==1
assert links['gold']['pairs']==[]
assert a==g and b[0]['content']==p[0]['content']
# A separate gold number gets the same association, with no annotation removed.
g['layout_dets'][0]['poly']=[100,200,500,200,500,250,100,250]
g['layout_dets'].append({'category_type':'equation_caption','poly':[850,210,900,210,900,240,850,240],'text':'(1)'})
a,b,links=m.measurement_regions(g,p,rule)
assert len(a['layout_dets'])==2 and a['layout_dets'][0]['poly']==[100,200,900,200,900,250,100,250]
assert a['layout_dets'][1]==g['layout_dets'][1]
# A right-side number binds the nearest preceding column, not the next column.
links=m.associate({0:[.1,.2,.3,.3],1:[.55,.2,.7,.3]}, {2:[.5,.22,.53,.28],3:[.85,.22,.9,.28]},rule)
assert [(x['formulaIndex'],x['numberIndex']) for x in links['pairs']]==[(0,2),(1,3)]
# Left-side numbering is eligible only with no candidate preceding the number.
assert m.associate({0:[.2,.2,.6,.3]},{1:[.1,.22,.15,.28]},rule)['pairs'][0]['formulaIndex']==0
# Neither duplicate alternatives nor two labels for a formula are guessed.
links=m.associate({0:[.1,.2,.5,.3],1:[.1,.2,.5,.3]},{2:[.8,.22,.9,.28]},rule)
assert not links['pairs'] and links['unboundNumbers'][0]['reason']=='equal-distance-formulas'
links=m.associate({0:[.1,.2,.5,.3]},{1:[.8,.22,.9,.24],2:[.8,.26,.9,.28]},rule)
assert not links['pairs'] and len(links['unboundNumbers'])==2
# Other-row and overlapping number boxes stay visible and unbound.
links=m.associate({0:[.1,.2,.5,.3]},{1:[.8,.4,.9,.5],2:[.2,.22,.3,.28]},rule)
assert not links['pairs'] and len(links['unboundNumbers'])==2
# Ignored gold cannot authorize a link, and inline formulas never acquire numbers.
g['layout_dets'][1]['ignore']=True
p[0]['category']='inline_formula'
a,b,links=m.measurement_regions(g,p,rule)
assert a==g and b==p and not links['gold']['pairs'] and not links['prediction']['pairs']
`], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
});
