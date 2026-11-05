import {
  researchJournalSaveSchema, researchJournalInspectSchema, researchJournalInspectionSchema,
  type ResearchJournalSave, type ResearchJournalReceipt, type ResearchJournalSelection,
  type ResearchJournalMaterial, type ResearchJournalInspect, type ResearchJournalInspection
} from '../../../shared/schemas/research-journal-compliance';
import {requireResearchHuman} from '../../services/research-human-context';
import {researchWorkspace, readResearchFile, researchContentHash} from './research-files';
import {checkJournalCompliance} from './journal-compliance-checks';
import type {ResearchRepository} from './repository';
import type {ResearchFigureService} from './figure-service';

export class ResearchJournalComplianceService {
  constructor(private readonly research: ResearchRepository, private readonly figures: Pick<ResearchFigureService, 'verify'>) {}

  private async capture(projectId: string, artifactId: string, selection: ResearchJournalSelection): Promise<ResearchJournalMaterial> {
    const facts = this.research.journalCompliance.captureFacts(projectId, artifactId, selection);
    for (const figure of facts.figures) await this.figures.verify(projectId, figure.id);
    const supplements: ResearchJournalMaterial['supplements'] = [];
    if (selection.supplementPaths.length > 0) {
      const root = await researchWorkspace(this.research.getProject(projectId).workspacePath);
      for (const path of selection.supplementPaths) {
        const bytes = await readResearchFile(root, path, 64 * 1024 * 1024);
        supplements.push({path, size: bytes.length, sha256: researchContentHash(bytes)});
      }
    }
    if (JSON.stringify(this.research.journalCompliance.captureFacts(projectId, artifactId, selection)) !== JSON.stringify(facts)) {
      throw new Error('research_journal_source_changed');
    }
    return {...facts, supplements};
  }

  async save(input: ResearchJournalSave): Promise<ResearchJournalReceipt> {
    const request = researchJournalSaveSchema.parse(input);
    requireResearchHuman('research.journalCompliance.save', request.projectId);
    const material = await this.capture(request.projectId, request.artifactId, request.selection);
    return this.research.journalCompliance.save(request, material);
  }

  async verify(receipt: ResearchJournalReceipt): Promise<void> {
    const {request, material} = receipt.snapshot;
    if (JSON.stringify(await this.capture(request.projectId, request.artifactId, request.selection)) !== JSON.stringify(material)) {
      throw new Error('research_journal_source_changed');
    }
  }

  async inspect(input: ResearchJournalInspect): Promise<ResearchJournalInspection> {
    const request = researchJournalInspectSchema.parse(input);
    this.research.journalCompliance.scope(request.projectId, request.artifactId);
    const artifactVersion = this.research.inspectArtifact({
      projectId: request.projectId, artifactId: request.artifactId, expectedVersion: null
    }).snapshot.version;
    const review = this.research.journalCompliance.latest(request.projectId, request.artifactId);
    const selection = request.selection ?? review?.snapshot.request.selection ?? null;
    const material = selection === null ? null : await this.capture(request.projectId, request.artifactId, selection);
    if (this.research.inspectArtifact({projectId: request.projectId, artifactId: request.artifactId,
      expectedVersion: null}).snapshot.version !== artifactVersion) throw new Error('research_journal_artifact_changed');
    const report = {projectId: request.projectId, artifactId: request.artifactId, artifactVersion, selection, material,
      materialHash: material === null ? null : researchContentHash(JSON.stringify(material)),
      checks: selection === null || material === null ? [] : checkJournalCompliance(selection, material),
      review, reviewCurrent: review !== null && JSON.stringify(selection) === JSON.stringify(review.snapshot.request.selection) &&
        JSON.stringify(material) === JSON.stringify(review.snapshot.material)};
    const reportHash = researchContentHash(JSON.stringify(report));
    return researchJournalInspectionSchema.parse({
      status: request.expectedHash === null || request.expectedHash === reportHash ? 'current' : 'stale', reportHash, report
    });
  }
}
