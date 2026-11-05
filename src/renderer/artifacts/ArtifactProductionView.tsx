import {lazy, Suspense} from 'react';
import type {ResearchArtifactInspectRequest} from '../../shared/schemas/research-artifact-inspector';
import type {ResearchProductionInput} from '../../shared/schemas/research-production-inputs';
import {useAsyncResource} from '../app/use-async-resource';
import type {RocClient} from '../shared/roc-client';
import {formSecondaryButtonClass} from '../shared/form-ui';
import {ProductionFiles} from './production/ProductionFiles';
import type {ProductionFileLocation} from './artifact-reading-location';

const ExperimentSourceView=lazy(async()=>({default:(await import('./production/ExperimentSourceView')).ExperimentSourceView}));
const FigureSourceView=lazy(async()=>({default:(await import('./production/FigureSourceView')).FigureSourceView}));
const ExportSourceView=lazy(async()=>({default:(await import('./production/ExportSourceView')).ExportSourceView}));

function SourceView({input,client,request,writable}: {
  input: ResearchProductionInput;client: RocClient;request: ResearchArtifactInspectRequest;writable: boolean
}): React.JSX.Element {
  switch(input.source.kind) {
    case 'experiment': return <ExperimentSourceView key={`${input.source.execution.id}:${request.expectedVersion}`}
      source={input.source} client={client} request={request} writable={writable}/>;
    case 'figure': return <FigureSourceView source={input.source}/>;
    case 'export': return <ExportSourceView source={input.source}/>;
  }
}

export function ArtifactProductionView({client,request,writable,initialLocation,onLocationChange}: {
  client: RocClient;request: ResearchArtifactInspectRequest;initialLocation: ProductionFileLocation | null;
  writable: boolean;onLocationChange: (location: ProductionFileLocation) => void
}): React.JSX.Element {
  const production=useAsyncResource(`production:review:${JSON.stringify(request)}`,()=>{
    if(request.expectedVersion===null) throw new Error('research_production_review_version_required');
    return client.api.research.inspectProductionReview({...request,expectedVersion:request.expectedVersion});
  },{label:'核对生产文件'});
  const input=production.status==='ready'?production.data:null;
  return <section className="flex flex-col gap-3 border-t-[0.5px] border-line pt-3" aria-label="生产工件" data-testid="artifact-production">
    {production.status==='loading'?<p role="status">正在核对保存的生产文件…</p>:null}
    {production.error===null?null:<div className="flex flex-col items-start gap-2">
      <p role="alert" className="break-words text-[var(--st-warn)]">{production.error}</p>
      <button type="button" className={formSecondaryButtonClass} onClick={production.reload}>重试文件核对</button>
    </div>}
    {input===null?null:<>
      <p className="text-muted">已校验保存的文件版本。工件{input.artifact.status==='approved'?'已批准':'仍等待人工决定'}。</p>
      <Suspense fallback={<p role="status">正在加载生产来源…</p>}><SourceView input={input} client={client} request={request} writable={writable}/></Suspense>
      <ProductionFiles client={client} input={input} request={request} initialLocation={initialLocation} onLocationChange={onLocationChange}/>
    </>}
  </section>;
}
