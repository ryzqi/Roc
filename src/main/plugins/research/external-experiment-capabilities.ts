import {
  researchExternalExperimentCreateSchema,researchExternalExperimentBindSchema,researchExternalExperimentRecordSchema,
  researchExternalExperimentGetSchema,researchExternalExperimentListSchema,researchExternalExperimentListResultSchema,
  researchExternalExperimentPreviewSchema,researchExternalExperimentPreviewResultSchema,researchExternalExperimentImportSchema,
  researchExternalExperimentResultSchema,researchExternalExperimentResultGetSchema,researchExternalExperimentResultsListSchema,
  researchExternalExperimentResultsSchema,researchExternalExperimentCaptureSchema,researchExternalExperimentDerivationSchema
} from '../../../shared/schemas/research-external-experiments';
import {researchExternalExperimentFigureSchema} from '../../../shared/schemas/research-external-figure';
import {researchResultFigureSourceSchema} from '../../../shared/schemas/research-result-figure-source';
import {researchEvidenceSchema} from '../../../shared/schemas/research-evidence';
import type {RocPluginContext} from '../../kernel/types';
import type {ExternalExperimentService} from './external-experiment-service';
import type {ResearchWorkspaceFileService} from './workspace-files';
import {saveDerivedFigureSource} from './result-figure-source';
const version='1.0.0';
const capabilities={
  create:{name:'research.externalExperiments.create',version,inputSchema:researchExternalExperimentCreateSchema,outputSchema:researchExternalExperimentRecordSchema},
  bind:{name:'research.externalExperiments.bind',version,inputSchema:researchExternalExperimentBindSchema,outputSchema:researchExternalExperimentRecordSchema},
  get:{name:'research.externalExperiments.get',version,inputSchema:researchExternalExperimentGetSchema,outputSchema:researchExternalExperimentRecordSchema},
  list:{name:'research.externalExperiments.list',version,inputSchema:researchExternalExperimentListSchema,outputSchema:researchExternalExperimentListResultSchema},
  previewImport:{name:'research.externalExperiments.previewImport',version,inputSchema:researchExternalExperimentPreviewSchema,outputSchema:researchExternalExperimentPreviewResultSchema},
  importResult:{name:'research.externalExperiments.importResult',version,inputSchema:researchExternalExperimentImportSchema,outputSchema:researchExternalExperimentResultSchema},
  getResult:{name:'research.externalExperiments.getResult',version,inputSchema:researchExternalExperimentResultGetSchema,outputSchema:researchExternalExperimentResultSchema},
  listResults:{name:'research.externalExperiments.listResults',version,inputSchema:researchExternalExperimentResultsListSchema,outputSchema:researchExternalExperimentResultsSchema},
  captureMetric:{name:'research.externalExperiments.captureMetric',version,inputSchema:researchExternalExperimentCaptureSchema,outputSchema:researchEvidenceSchema},
  derive:{name:'research.externalExperiments.derive',version,inputSchema:researchExternalExperimentResultGetSchema,outputSchema:researchExternalExperimentDerivationSchema},
  prepareFigure:{name:'research.externalExperiments.prepareFigure',version,inputSchema:researchExternalExperimentFigureSchema,outputSchema:researchResultFigureSourceSchema}
};
export const researchExternalExperimentCapabilities=Object.values(capabilities);
export function registerResearchExternalExperimentCapabilities(context:RocPluginContext,service:ExternalExperimentService,
  workspaceFiles:Pick<ResearchWorkspaceFileService,'read'|'save'>):void{
  context.capabilities.register(context.pluginId,capabilities.create,async input=>service.create(input));
  context.capabilities.register(context.pluginId,capabilities.bind,async input=>service.bind(input));
  context.capabilities.register(context.pluginId,capabilities.get,async input=>service.get(input));
  context.capabilities.register(context.pluginId,capabilities.list,async input=>service.list(input));
  context.capabilities.register(context.pluginId,capabilities.previewImport,input=>service.previewImport(input));
  context.capabilities.register(context.pluginId,capabilities.importResult,input=>service.importResult(input));
  context.capabilities.register(context.pluginId,capabilities.getResult,async input=>service.getResult(input));
  context.capabilities.register(context.pluginId,capabilities.listResults,async input=>service.listResults(input));
  context.capabilities.register(context.pluginId,capabilities.captureMetric,async input=>service.captureMetric(input));
  context.capabilities.register(context.pluginId,capabilities.derive,async input=>service.derive(input));
  context.capabilities.register(context.pluginId,capabilities.prepareFigure,async input=>{
    const {sourceHash,...selection}=input;
    const result=service.derive(selection),figure=result.figures.find(figure=>figure.sourceHash===sourceHash);
    if(figure===undefined)throw new Error('research_result_figure_changed');
    return saveDerivedFigureSource(workspaceFiles,input.projectId,figure);
  });
}
