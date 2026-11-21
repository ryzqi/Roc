import {researchResultFigureSourceRequestSchema, type ResearchResultFigureSourceRequest} from '../../../shared/schemas/research-result-figure-source';
import type {ResearchResultDerivationService} from './result-derivation-service';
import type {ResearchWorkspaceFileService} from './workspace-files';
import {researchContentHash} from './research-files';

export class ResearchResultFigureSourceService {
  constructor(private readonly derivation: Pick<ResearchResultDerivationService, 'preview'>,
    private readonly workspaceFiles: Pick<ResearchWorkspaceFileService, 'read' | 'save'>) {}

  async prepare(input: ResearchResultFigureSourceRequest): Promise<{sourcePath: string; sourceHash: string}> {
    const {projectId, sourceHash, ...selection} = researchResultFigureSourceRequestSchema.parse(input);
    const preview = await this.derivation.preview({projectId, ...selection});
    const chart = preview.figures.find(figure => figure.sourceHash === sourceHash);
    if (chart === undefined) throw new Error('research_result_figure_changed');
    return saveDerivedFigureSource(this.workspaceFiles,projectId,chart);
  }
}

export async function saveDerivedFigureSource(workspaceFiles:Pick<ResearchWorkspaceFileService,'read'|'save'>,
  projectId:string,chart:{sourceHash:string;source:string}):Promise<{sourcePath:string;sourceHash:string}>{
  const {sourceHash}=chart;
  if(researchContentHash(chart.source)!==sourceHash)throw new Error('research_result_figure_changed');
  const sourcePath = `results/${sourceHash}.vl.json`;
  const existing = async (): Promise<boolean> => {
    try {
      const saved = await workspaceFiles.read(projectId, sourcePath);
      if (saved.sha256 !== sourceHash) throw new Error('research_result_figure_changed');
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  };
  if (!await existing()) {
    try {await workspaceFiles.save({projectId, path: sourcePath, content: chart.source, expectedHash: null});}
    catch (error) {
      if (!(error instanceof Error) || (error.message !== 'research_workspace_file_exists' && (error as NodeJS.ErrnoException).code !== 'EEXIST')) throw error;
      if (!await existing()) throw error;
    }
  }
  return {sourcePath, sourceHash};
}
