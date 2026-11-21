import {
  researchProposalCreateSchema, type ResearchProposalCreate, type ResearchProposalGet, type ResearchProposalList,
  type ResearchProposalReject, type ResearchProposalInspection, type ResearchProposalListResult
} from '../../../shared/schemas/research-proposals';
import {researchFigureDataPath} from '../../../shared/schemas/research-figure-data';
import type {ResearchRepository} from './repository';
import type {ResearchExperimentService} from './experiment-service';
import type {ResearchExperimentResultService} from './experiment-result-service';
import type {ResearchFigureService} from './figure-service';
import type {ResearchJournalComplianceService} from './journal-compliance-service';

/** Verify managed files through their existing owners; proposal storage itself remains synchronous. */
export class ResearchProposalService {
  constructor(private readonly research: ResearchRepository,
    private readonly experiments: Pick<ResearchExperimentService, 'verifyPublication'>,
    private readonly results: Pick<ResearchExperimentResultService, 'get'>,
    private readonly figures: Pick<ResearchFigureService, 'verify' | 'readRunFile'>,
    private readonly journal: Pick<ResearchJournalComplianceService, 'inspect'>) {}

  async create(input: ResearchProposalCreate): Promise<ResearchProposalInspection> {
    const request = researchProposalCreateSchema.parse(input);
    const replay = this.research.proposals.replay(request);
    if (replay !== null) return await this.inspectFiles(replay);
    await this.verifyFiles(request);
    return await this.inspectFiles(this.research.proposals.create(request));
  }
  async get(input: ResearchProposalGet): Promise<ResearchProposalInspection> {
    return await this.inspectFiles(this.research.proposals.get(input));
  }
  async list(input: ResearchProposalList): Promise<ResearchProposalListResult> {
    const page = this.research.proposals.list(input), items: ResearchProposalInspection[] = [];
    for (const item of page.items) items.push(await this.inspectFiles(item));
    return {items, total: page.total};
  }
  async reject(input: ResearchProposalReject): Promise<ResearchProposalInspection> {
    return await this.inspectFiles(this.research.proposals.reject(input));
  }
  private async inspectFiles(item: ResearchProposalInspection): Promise<ResearchProposalInspection> {
    if (item.freshness === 'stale') return item;
    try {await this.verifyFiles(item.snapshot.request);}
    catch (error) {
      if (!(error instanceof Error)) throw error;
      const code = error.message.split(':')[0];
      if (!/changed|mismatch|not_found|missing|invalid|required|conflict|ENOENT/u.test(code)) throw error;
      return {...item, freshness: 'stale', staleReasons: [...item.staleReasons,
        {artifactId: item.snapshot.request.artifactId, reason: code.slice(0, 300)}]};
    }
    // File checks await I/O. Re-read the domain baseline afterwards before returning a usable suggestion.
    return this.research.proposals.get({projectId: item.snapshot.request.projectId, proposalId: item.snapshot.id});
  }
  private async verifyFiles(request: ResearchProposalCreate): Promise<void> {
    const {projectId, proposal, artifactId} = request;
    if (this.research.getArtifact(artifactId).projectId !== projectId) throw new Error('research_proposal_project_mismatch');
    switch (proposal.kind) {
      case 'consistency':
      case 'figure_consistency':
        const receipts = new Map(proposal.payload.bindings.map(binding => [binding.resultHash, binding.resultId]));
        for (const [expectedHash, resultId] of receipts) await this.results.get({projectId, resultId, expectedHash});
        if (proposal.kind === 'figure_consistency') {
          const figure = await this.figures.verify(projectId, proposal.payload.figure.id);
          const trace = await this.figures.readRunFile({projectId, runId: figure.runId, area: 'output', path: researchFigureDataPath});
          if (figure.artifactId !== artifactId || figure.manifestHash !== proposal.payload.figure.manifestHash ||
              trace.file.sha256 !== proposal.payload.figure.traceHash) throw new Error('research_proposal_material_changed');
        }
        break;
      case 'experiment_result': {
        const payload = proposal.payload, run = await this.experiments.verifyPublication(projectId, artifactId);
        if (run.id !== payload.runId || run.inputHash !== payload.expectedInputHash ||
            !run.files.some(file => file.area === 'output' && file.path === payload.resultPath && file.sha256 === payload.expectedResultHash)) {
          throw new Error('research_proposal_material_changed');
        }
        break;
      }
      case 'journal_compliance': {
        const report = await this.journal.inspect({projectId, artifactId, selection: proposal.payload.selection, expectedHash: null});
        if (report.report.materialHash !== proposal.payload.expectedMaterialHash ||
            report.report.artifactVersion !== request.expectedArtifactVersion) throw new Error('research_proposal_material_changed');
        break;
      }
      case 'argument_outline':
      case 'idea_plan':
      case 'citation_review':
      case 'response_matrix':
        break;
    }
  }
}
