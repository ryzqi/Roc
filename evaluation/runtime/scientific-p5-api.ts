/** Minimal production API for an isolated, original-PDF engineering trial. No fixture IR or model output. */
export {ResearchRepository} from '../../src/main/plugins/research/repository';
export {ResearchTaskRepository} from '../../src/main/plugins/research/research-task-repository';
export {applyAgentDatabaseSchema, applyResearchDatabaseSchema} from '../../src/main/infrastructure/database-schemas';
export {parseResearchDocument} from '../../src/main/plugins/research/document-parser';
export {collectDocumentContent} from '../../src/main/plugins/research/document-files';
export {PaperIRRepository} from '../../src/main/plugins/research/paper-ir-repository';
export {ResearchEmbeddingService} from '../../src/main/plugins/research/embedding-service';
export {ScholarlyRelationsRepository} from '../../src/main/plugins/research/scholarly-relations-repository';
export {ScientificRetrievalRouter} from '../../src/main/plugins/research/scientific-retrieval-router';
export {ScientificQueryOrchestrator} from '../../src/main/plugins/research/scientific-query-orchestrator';
