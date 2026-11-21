import type {z} from 'zod';
import type {researchExperimentMetricSchema, researchExperimentMetricDefinitionSchema} from '../../../shared/schemas/research-experiment-results';
import {researchContentHash} from './research-files';
type Row={ordinal:number;metric:z.infer<typeof researchExperimentMetricSchema>;definition:z.infer<typeof researchExperimentMetricDefinitionSchema>};

/** A deterministic editable source contains only exact reported values and its frozen provenance reference. */
export function buildMetricFigureSources(reference:Record<string,string>,rows:readonly Row[]):Array<{
  unit:string;filename:string;source:string;sourceHash:string;metricIds:string[]
}> {
  const units=new Map<string,Row[]>();
  for(const row of rows){const group=units.get(row.metric.unit);if(group===undefined)units.set(row.metric.unit,[row]);else group.push(row);}
  return [...units].map(([unit,group])=>{
    const source=JSON.stringify({description:'Reviewed metric report',usermeta:{roc:reference},
      data:{values:group.map(({metric,definition,ordinal})=>({metricId:metric.id,label:definition.label,value:metric.value,
        unit,sampleSize:metric.sampleSize,metricOrdinal:ordinal}))},mark:{type:'point',filled:true},
      encoding:{x:{field:'metricId',type:'nominal',title:'指标',sort:group.map(row=>row.metric.id)},
        y:{field:'value',type:'quantitative',title:unit},tooltip:[{field:'label',type:'nominal'},{field:'value',type:'quantitative'},
          {field:'unit',type:'nominal'},{field:'sampleSize',type:'quantitative'}]}
    },null,2)+'\n';
    const sourceHash=researchContentHash(source);
    return {unit,filename:`results-${sourceHash.slice(0,20)}.vl.json`,source,sourceHash,metricIds:group.map(row=>row.metric.id)};
  });
}
