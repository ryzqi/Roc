export { ResearchRepository } from '../../../src/main/plugins/research/repository';
export { ResearchProductionEffectService } from '../../../src/main/plugins/research/production-effects';
export { createResearchRoleTools } from '../../../src/main/plugins/research/role-tools';
export { createResearchTools } from '../../../src/main/plugins/agent/research-tools';
export {dispatchReviewQuery} from '../../../src/main/plugins/agent/review-query-tools';
export {createManifestAuthorizedResearchTools} from '../../../src/main/plugins/agent/run-harness';
export {RESEARCH_TOOL_DESCRIPTORS} from '../../../src/main/plugins/agent/research-tools';
export {createToolOutputProjector} from '../../../src/main/services/deep-agent/tool-output-projection';
export {ContextArtifactStore} from '../../../src/main/services/deep-agent/context/context-artifact-store';
export {researchReviewLinksSchema, reviewLinksPayload} from '../../../src/shared/schemas/research-review-links';
export { getResearchStageRoleProfile } from '../../../src/main/plugins/research/role-profiles';
export { applyResearchDatabaseSchema } from '../../../src/main/infrastructure/database-schemas';
export { ResearchFigureService } from '../../../src/main/plugins/research/figure-service';
export {ResearchFigureConsistencyService} from '../../../src/main/plugins/research/figure-consistency-service';
export {registerResearchFigureConsistencyCapabilities} from '../../../src/main/plugins/research/figure-consistency-capabilities';
export * from '../../../src/shared/schemas/research-figure-consistency';
export { renderResearchFigure } from '../../../src/main/plugins/research/figure-renderer';
export { ResearchTaskRepository } from '../../../src/main/plugins/research/research-task-repository';
export { ResearchStageRuntime } from '../../../src/main/plugins/research/stage-runtime';
export { ExecutionGrantBroker, openExecutionGrantBroker, assertResearchDispatchGrant, assertReviewSearchDispatchGrant,
  assertReviewSearchOwner } from '../../../src/main/services/deep-agent/execution-grant-broker';
export { withResearchDispatchReference } from '../../../src/main/services/research-dispatch-context';
export {withReviewSearchDispatch, reviewSearchDispatchContext, reviewSearchDispatchRequestHash} from '../../../src/main/services/research-review-dispatch-context';
export {withReviewSearchOwner} from '../../../src/main/services/research-review-owner-context';
export { registerResearchRunCapabilities } from '../../../src/main/plugins/research/run-capabilities';
export { registerResearchExperimentCapabilities, researchExperimentCapabilities } from '../../../src/main/plugins/research/experiment-capabilities';
export { registerResearchFigureCapabilities } from '../../../src/main/plugins/research/figure-capabilities';
export { registerResearchExportCapabilities } from '../../../src/main/plugins/research/export-capabilities';
export { agentMigrations, researchMigrations } from '../../../src/main/infrastructure/database-schemas';
export { applyDatabaseMigrations } from '../../../src/main/infrastructure/database-migrations';
export { configureRocDatabaseConnection } from '../../../src/main/infrastructure/database-pragmas';
export { compileRunCapabilityManifest, bindMcpToolContracts } from '../../../src/main/plugins/agent/run-capability-manifest';
export { createRunBudget, createRunExecutionSnapshot } from '../../../src/main/plugins/agent/run-execution-snapshot';
export { parseIpcRequestArgs } from '../../../src/shared/ipc-registry';
export { RunBudgetLedger } from '../../../src/main/services/deep-agent/run-budget-ledger';
export { RunBudgetObserver } from '../../../src/main/services/deep-agent/run-budget-observer';
export { createResearchRoleExecutor } from '../../../src/main/plugins/research/role-executor';
export { ResearchTaskController } from '../../../src/main/plugins/research/task-controller';
export { registerResearchTaskCapabilities, researchTaskCapabilities } from '../../../src/main/plugins/research/task-capabilities';
export { createAgentPlugin } from '../../../src/main/plugins/agent';
export { createResearchHumanGate } from '../../../src/main/plugins/research/human-gate';
export { ResearchTaskDiagnosticsService } from '../../../src/main/plugins/research/task-diagnostics';
export { notifyResearchTaskChanged } from '../../../src/main/plugins/research/task-notifications';
export { ProjectBudgetLedger } from '../../../src/main/services/deep-agent/project-budget-ledger';
export { registerResearchProjectBudgetCapabilities } from '../../../src/main/plugins/research/project-budget-capabilities';
export { ResearchExperimentService } from '../../../src/main/plugins/research/experiment-service';
export {ResearchExperimentResultService} from '../../../src/main/plugins/research/experiment-result-service';
export {registerResearchExperimentResultCapabilities} from '../../../src/main/plugins/research/experiment-result-capabilities';
export * from '../../../src/shared/schemas/research-experiment-results';
export { ResearchExperimentEnvironmentService } from '../../../src/main/plugins/research/experiment-environment';
export { inspectNativeExperimentEnvironment } from '../../../src/main/plugins/research/experiment-native-environment';
export { inspectPythonExperimentEnvironment, pythonEnvironmentProbe, pythonExperimentFlags } from '../../../src/main/plugins/research/experiment-python-probe';
export { runPythonExperimentProcess, pythonExperimentBootstrap, pythonExperimentBootstrapHash, pythonExecutionStartupSchema } from '../../../src/main/plugins/research/experiment-python-process';
export { pythonExecutionReportSchema } from '../../../src/main/plugins/research/experiment-python-process';
export {
  assertPythonCodeReceipt, pythonCodeReceiptSchema, pythonCodeReportSchema,
  pythonEnvironmentControlsSchema, pythonEnvironmentLockSchema
} from '../../../src/main/plugins/research/experiment-python-code-schema';
export { ResearchPythonEnvironmentService } from '../../../src/main/plugins/research/python-environment-service';
export { registerResearchPythonEnvironmentCapabilities } from '../../../src/main/plugins/research/python-environment-capabilities';
export { registerResearchNotebookCapabilities } from '../../../src/main/plugins/research/notebook-capabilities';
export { runEnvironmentProbe } from '../../../src/main/plugins/research/experiment-probe-resources';
export { discoverJuliaEnvironmentControls, parseJuliaRuntimeVersion } from '../../../src/main/plugins/research/experiment-julia-controls';
export { captureNativeCode } from '../../../src/main/plugins/research/experiment-native-code';
export { ResearchExportFiles } from '../../../src/main/plugins/research/export-files';
export { nativeCodeLimits, nativeCodeReceiptSchema, nativeCodeReportSchema, assertNativeCodeReceipt } from '../../../src/main/plugins/research/experiment-native-code-schema';
export { runResearchProcess, researchSandboxProfile, ResearchProcessError } from '../../../src/main/plugins/research/process-runner';
export { researchExperimentResourceReportSchema, researchProcessResourceUsageSchema } from '../../../src/shared/schemas/research-process-resources';
export { ResearchWorkspaceFileService } from '../../../src/main/plugins/research/workspace-files';
export { ResearchToolchain } from '../../../src/main/plugins/research/toolchain';
export { ResearchTemplateService } from '../../../src/main/plugins/research/template-service';
export { ResearchExportSourceService } from '../../../src/main/plugins/research/export-sources';
export {serializePublicExportScientificReview} from '../../../src/main/plugins/research/export-scientific-review';
export { ResearchExportService } from '../../../src/main/plugins/research/export-service';
export { LiteratureSearchService } from '../../../src/main/plugins/research/literature-service';
export {ScholarlyRelationsService} from '../../../src/main/plugins/research/scholarly-relations-service';
export {ScholarlyRelationsRepository} from '../../../src/main/plugins/research/scholarly-relations-repository';
export {readScholarlyMaterial, scholarlyEndpoint} from '../../../src/main/plugins/research/scholarly-provider-adapters';
export {registerResearchScholarlyCapabilities, researchScholarlyCapabilities} from '../../../src/main/plugins/research/scholarly-relations-capabilities';
export * from '../../../src/shared/schemas/research-scholarly-relations';
export {ResearchResourceService} from '../../../src/main/plugins/research/resource-service';
export {ResearchResourceRepository, resourceContentHash} from '../../../src/main/plugins/research/resource-repository';
export {readDataCiteMetadata, dataciteEndpoint} from '../../../src/main/plugins/research/datacite-adapter';
export {registerResearchResourceCapabilities, researchResourceCapabilities} from '../../../src/main/plugins/research/resource-capabilities';
export * from '../../../src/shared/schemas/research-resources';
export {ResearchResourceAssociationRepository} from '../../../src/main/plugins/research/resource-association-repository';
export {registerResearchResourceAssociationCapabilities, researchResourceAssociationCapabilities} from '../../../src/main/plugins/research/resource-association-capabilities';
export * from '../../../src/shared/schemas/research-resource-associations';
export { LiteratureImportService } from '../../../src/main/plugins/research/literature-import-service';
export { ZoteroAdapter } from '../../../src/main/plugins/research/zotero-adapter';
export { requireConfirmedSearchStrategy, searchPlanApprovalHash } from '../../../src/main/plugins/research/search-strategy';
export { withLiteratureContext } from '../../../src/main/services/literature-context';
export { ResearchLibraryService } from '../../../src/main/plugins/research/library-service';
export { ResearchDocumentService } from '../../../src/main/plugins/research/document-service';
export {registerResearchDocumentCapabilities, researchDocumentCapabilities} from '../../../src/main/plugins/research/document-capabilities';
export {registerResearchLibraryCapabilities, researchLibraryCapabilities} from '../../../src/main/plugins/research/library-capabilities';
export {registerResearchSystematicReviewCapabilities, researchSystematicReviewCapabilities} from '../../../src/main/plugins/research/systematic-review-capabilities';
export {ResearchReviewSearchService} from '../../../src/main/plugins/research/review-search-service';
export {registerResearchReviewSearchCapabilities, researchReviewSearchCapabilities} from '../../../src/main/plugins/research/review-search-capabilities';
export {registerResearchOwnedReviewSearchCapabilities, researchOwnedReviewSearchCapabilities} from '../../../src/main/plugins/research/review-search-capabilities';
export {ResearchReviewCorpusRepository} from '../../../src/main/plugins/research/review-corpus-repository';
export {registerResearchReviewCorpusCapabilities, researchReviewCorpusCapabilities} from '../../../src/main/plugins/research/review-corpus-capabilities';
export {LiteratureProviderGovernor} from '../../../src/main/plugins/research/literature-provider-governor';
export { AgentToolEffectStore, hashToolInput } from '../../../src/main/services/deep-agent/tool-effect-store';
export {withResearchWorker} from '../../../src/main/plugins/research/execution/worker-context';
export { createToolEffectIdempotencyMiddleware } from '../../../src/main/services/deep-agent/tool-effect-idempotency';
export { createMcpClientAdapter } from '../../../src/main/plugins/mcp/mcp-client-adapter';

export {registerResearchArtifactInspectorCapability, researchArtifactInspectorCapability} from '../../../src/main/plugins/research/artifact-inspector-capability';
export {createPluginCapabilityAdapter} from '../../../src/main/ipc/plugin-capability-adapter';
export {registerResearchEvidenceCapabilities, researchEvidenceCapabilities} from '../../../src/main/plugins/research/evidence-capabilities';
export {withResearchHumanContext, requireResearchHuman} from '../../../src/main/services/research-human-context';
export {CapabilityRegistry} from '../../../src/main/kernel/capability-registry';
export {researchWorkflowTransitionRequestSchema} from '../../../src/shared/schemas/research';
export {ResearchProductionInputService} from '../../../src/main/plugins/research/production-input-service';
export {registerResearchProductionInputCapabilities} from '../../../src/main/plugins/research/production-input-capabilities';
export {researchProductionInputSchema, researchProductionInputContentSchema} from '../../../src/shared/schemas/research-production-inputs';
export {researchSourceLocatorSchema} from '../../../src/shared/schemas/research-source-locator';
export {relationSourceDigest, relationClaimHash} from '../../../src/main/plugins/research/evidence-relation-repository';
export {captureExportScientificReview, assertCurrentExportScientificReview, serializeExportScientificReview, exportScientificReviewPath} from '../../../src/main/plugins/research/export-scientific-review';
export {researchExportSourcesSchema} from '../../../src/shared/schemas/research-exports';
export {researchExportScientificReviewSchema} from '../../../src/shared/schemas/research-export-review';
export {ResearchArtifactScientificReviewService, currentArtifactScientificReviews} from '../../../src/main/plugins/research/artifact-scientific-reviews';
export {captureExportArtifactReviews, redactExportFigureReview} from '../../../src/main/plugins/research/export-artifact-reviews';
export {researchExportFigureReviewSchema} from '../../../src/shared/schemas/research-export-review';
export {researchEvidenceRelationProposalSchema, researchEvidenceRelationReviewSchema} from '../../../src/shared/schemas/research-evidence-relations';

export {ResearchReviewDeduplicationRepository} from '../../../src/main/plugins/research/review-deduplication-repository';
export {registerResearchReviewDeduplicationCapabilities, researchReviewDeduplicationCapabilities} from '../../../src/main/plugins/research/review-deduplication-capabilities';

export {ResearchReviewScreeningRepository} from '../../../src/main/plugins/research/review-screening-repository';
export {registerResearchReviewScreeningCapabilities, researchReviewScreeningCapabilities} from '../../../src/main/plugins/research/review-screening-capabilities';

export {ResearchReviewScreeningDecisions} from '../../../src/main/plugins/research/review-screening-decisions';
export {createCapabilityOperationContext, runWithCapabilityOperationContext} from '../../../src/main/kernel/capability-operation-context';

export {ResearchReviewScreeningArbitration} from '../../../src/main/plugins/research/review-screening-arbitration';

export {ResearchReviewScreeningFreeze} from '../../../src/main/plugins/research/review-screening-freeze';
export {researchReviewScreeningDecisionSaveSchema, researchReviewScreeningDecisionSnapshotSchema, researchReviewScreeningArbitrationSaveSchema, researchReviewScreeningArbitrationSnapshotSchema} from '../../../src/shared/schemas/research-review-screening';

export {ResearchReviewFullTextRepository} from '../../../src/main/plugins/research/review-fulltext-repository';
export {registerResearchReviewFullTextCapabilities,researchReviewFullTextCapabilities} from '../../../src/main/plugins/research/review-fulltext-capabilities';
export {ResearchReviewFullTextScreening} from '../../../src/main/plugins/research/review-fulltext-screening';
export {registerResearchReviewFullTextScreeningCapabilities,researchReviewFullTextScreeningCapabilities} from '../../../src/main/plugins/research/review-fulltext-screening-capabilities';
export {ResearchReviewFullTextArbitration} from '../../../src/main/plugins/research/review-fulltext-arbitration';
export {researchReviewFullTextDecisionSaveSchema,researchReviewFullTextDecisionSnapshotSchema} from '../../../src/shared/schemas/research-review-fulltext-screening';
export {ResearchReviewFullTextFreeze} from '../../../src/main/plugins/research/review-fulltext-freeze';
export {researchReviewFullTextBindingSnapshotSchema} from '../../../src/shared/schemas/research-review-fulltext';
export {ResearchReviewExtractionRepository} from '../../../src/main/plugins/research/review-extraction-repository';
export {registerResearchReviewExtractionCapabilities,researchReviewExtractionCapabilities} from '../../../src/main/plugins/research/review-extraction-capabilities';
export {ResearchReviewQualityPlanRepository} from '../../../src/main/plugins/research/review-quality-plan-repository';
export {registerResearchReviewQualityCapabilities,researchReviewQualityCapabilities} from '../../../src/main/plugins/research/review-quality-capabilities';
export {researchReviewExtractionSaveSchema,researchReviewExtractionSnapshotSchema} from '../../../src/shared/schemas/research-review-extraction';
export {ResearchReviewQualityAssessmentRepository} from '../../../src/main/plugins/research/review-quality-assessment-repository';
export {researchReviewQualityAssessmentSaveSchema,researchReviewQualityAssessmentSnapshotSchema} from '../../../src/shared/schemas/research-review-quality';
export {ResearchReviewStudiesRepository} from '../../../src/main/plugins/research/review-studies-repository';
export {researchReviewStudiesCapabilities,registerResearchReviewStudiesCapabilities} from '../../../src/main/plugins/research/review-studies-capabilities';
export {researchReviewStudiesSaveSchema,researchReviewStudiesSnapshotSchema} from '../../../src/shared/schemas/research-review-studies';
export {ResearchReviewReportService} from '../../../src/main/plugins/research/review-report-service';
export {researchReviewReportCapability,registerResearchReviewReportCapability} from '../../../src/main/plugins/research/review-report-capability';
export {researchReviewReportBodySchema} from '../../../src/shared/schemas/research-review-report';

export * from '../../../src/shared/schemas/research-idea-plans';
export {registerResearchIdeaPlanCapabilities} from '../../../src/main/plugins/research/idea-plan-capabilities';
export {ResearchIdeaPlanRepository} from '../../../src/main/plugins/research/idea-plan-repository';
export * from '../../../src/shared/schemas/research-idea-outcomes';
export {ResearchIdeaOutcomeRepository} from '../../../src/main/plugins/research/idea-outcome-repository';
export {ResearchIdeaOutcomeService} from '../../../src/main/plugins/research/idea-outcome-service';
export {registerResearchIdeaOutcomeCapabilities} from '../../../src/main/plugins/research/idea-outcome-capabilities';
export * from '../../../src/shared/schemas/research-citation-coverage';
export {ResearchCitationCoverageService} from '../../../src/main/plugins/research/citation-coverage-service';
export {registerResearchCitationCoverageCapability} from '../../../src/main/plugins/research/citation-coverage-capability';
export * from '../../../src/shared/schemas/research-citation-reviews';
export {ResearchCitationReviewRepository} from '../../../src/main/plugins/research/citation-review-repository';
export {registerResearchCitationReviewCapabilities} from '../../../src/main/plugins/research/citation-review-capabilities';
export * from '../../../src/shared/schemas/research-consistency';
export {calculateConsistency, consistencyNumericLocations} from '../../../src/main/plugins/research/consistency-calculation';
export {ResearchConsistencyService} from '../../../src/main/plugins/research/consistency-service';
export {registerResearchConsistencyCapabilities} from '../../../src/main/plugins/research/consistency-capabilities';

export {registerResearchResponseMatrixCapabilities, researchResponseMatrixCapabilities} from '../../../src/main/plugins/research/response-matrix-capabilities';
export {researchResponseMatrixSaveSchema, researchResponseMatrixReceiptSchema} from '../../../src/shared/schemas/research-response-matrix';

export {ResearchJournalComplianceService} from '../../../src/main/plugins/research/journal-compliance-service';
export {registerResearchJournalComplianceCapabilities} from '../../../src/main/plugins/research/journal-compliance-capabilities';
export {researchJournalSaveSchema, researchJournalReceiptSchema} from '../../../src/shared/schemas/research-journal-compliance';

export * from '../../../src/shared/schemas/research-huggingface';
export {huggingFaceEndpoint, readHuggingFaceMetadata} from '../../../src/main/plugins/research/huggingface-adapter';
export {HuggingFaceRepository} from '../../../src/main/plugins/research/huggingface-repository';
export {HuggingFaceService} from '../../../src/main/plugins/research/huggingface-service';
export * from '../../../src/shared/schemas/research-huggingface-downloads';
export {HuggingFaceDownloadRepository} from '../../../src/main/plugins/research/huggingface-download-repository';
export {HuggingFaceDownloadService, huggingFaceDownloadDirectory} from '../../../src/main/plugins/research/huggingface-download-service';
export {HuggingFaceDownloader, huggingFaceResolveUrl, requireHuggingFaceDownloadUrl} from '../../../src/main/plugins/research/huggingface-downloader';
export {createLiteratureProviderGovernor} from '../../../src/main/plugins/research/literature-provider-governor';
export {registerResearchHuggingFaceDownloadCapabilities, researchHuggingFaceDownloadCapabilities} from '../../../src/main/plugins/research/huggingface-download-capabilities';
export {registerResearchHuggingFaceCapabilities, researchHuggingFaceCapabilities} from '../../../src/main/plugins/research/huggingface-capabilities';

export * from '../../../src/shared/schemas/research-openreview';
export {openReviewEndpoint, readOpenReviewPage} from '../../../src/main/plugins/research/openreview-adapter';
export {OpenReviewRepository} from '../../../src/main/plugins/research/openreview-repository';
export {OpenReviewService} from '../../../src/main/plugins/research/openreview-service';
export {BackgroundDeadlines} from '../../../src/main/services/background-deadlines';
export {TaskScheduler} from '../../../src/main/plugins/task/scheduler';
export {registerResearchOpenReviewCapabilities, researchOpenReviewCapabilities} from '../../../src/main/plugins/research/openreview-capabilities';

export * from '../../../src/shared/schemas/research-monitors';
export {ResearchMonitorRepository, sealMonitor} from '../../../src/main/plugins/research/monitor-repository';
export {ResearchMonitorService} from '../../../src/main/plugins/research/monitor-service';
export {readMonitorUpdates, monitorUpdateEndpoint, searchMonitorMaterial} from '../../../src/main/plugins/research/monitor-provider-adapter';
export {registerResearchMonitorCapabilities, researchMonitorCapabilities} from '../../../src/main/plugins/research/monitor-capabilities';
export {bibliographyFromRecord} from '../../../src/main/plugins/research/literature-service';

export * from '../../../src/shared/schemas/research-zenodo';
export {ZenodoPreparationService, sealZenodo} from '../../../src/main/plugins/research/zenodo-preparation';
export {hashZenodoFile} from '../../../src/main/plugins/research/zenodo-file';
export {registerResearchZenodoCapabilities, researchZenodoCapabilities} from '../../../src/main/plugins/research/zenodo-capabilities';

export * from '../../../src/shared/schemas/research-zenodo-remote';
export {ZenodoPublicationService} from '../../../src/main/plugins/research/zenodo-publication';
export {ZenodoOperationRepository} from '../../../src/main/plugins/research/zenodo-operation-repository';
export {ZenodoTransport, ZenodoTransportError, readZenodoDeposition, zenodoBucket} from '../../../src/main/plugins/research/zenodo-transport';
export {uploadZenodoFile} from '../../../src/main/plugins/research/zenodo-upload';
export {SecretManager} from '../../../src/main/infrastructure/secret-manager';
export {applyCoreDatabaseSchema} from '../../../src/main/infrastructure/database-schemas';
export {researchZenodoPublicationCapabilities, registerResearchZenodoPublicationCapabilities} from '../../../src/main/plugins/research/zenodo-publication-capabilities';

export {ResearchStorageUsageService, researchStorageCapability, registerResearchStorageCapability} from '../../../src/main/plugins/research/storage-usage';

export {ResearchTaskFactsService} from '../../../src/main/plugins/research/task-facts';
export {taskFactsHash} from '../../../src/main/plugins/research/task-facts-store';
export {createResearchTaskContextMiddleware} from '../../../src/main/services/deep-agent/research-task-context-middleware';
export {taskFactCapabilities, registerTaskFactCapabilities} from '../../../src/main/plugins/research/task-fact-capabilities';

export {ResearchTaskDiagnosticsExporter} from '../../../src/main/plugins/research/task-diagnostics-export';
export {AgentRunTelemetryAccumulator} from '../../../src/main/plugins/agent/run-telemetry';
export {AgentRunEventLog} from '../../../src/main/plugins/agent/run-event-log';
export {scientificReviewHash} from '../../../src/main/plugins/research/verification/scientific-review';
export {scientificReviewOutputSchema, scientificCriteria} from '../../../src/shared/schemas/research-scientific-review';

export {captureExportValidation, assertCurrentExportValidation, assertCurrentExportReviews} from '../../../src/main/plugins/research/export-validation';
export {exportValidationPath} from '../../../src/shared/schemas/research-export-validation';
export {serializeResearchPublicProjection} from '../../../src/main/plugins/research/export-public-projection';

export {ReadingRepository} from '../../../src/main/plugins/research/reading-repository';
export {RadarService} from '../../../src/main/plugins/research/radar-service';
export {ReadingDiscoveryService} from '../../../src/main/plugins/research/reading-discovery';
export {ReadingTranslationService} from '../../../src/main/plugins/research/reading-translation';
export {parseRadarFeed, cosineSimilarity, plainArticleText} from '../../../src/main/plugins/research/radar-parser';
export {fetchReadingText, publicReadingUrl} from '../../../src/main/plugins/research/reading-network';
export * from '../../../src/shared/schemas/research-reading';

export {researchWikiCapabilities, registerResearchWikiCapabilities} from '../../../src/main/plugins/research/wiki-capabilities';
export {createWikiTools, WIKI_TOOL_DESCRIPTORS} from '../../../src/main/plugins/agent/wiki-tools';
export {filterPlanModeModelTools, createRocPlanRuntimeToolGuardMiddleware} from '../../../src/main/services/deep-agent/model-tool-exposure';
