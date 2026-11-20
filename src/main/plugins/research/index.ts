import type { RocPlugin } from '../../kernel/types';
import { OpenAICompatibleEmbeddingClient } from './embedding-client';
import { LiteratureSearchService } from './literature-service';
import { ZoteroAdapter } from './zotero-adapter';
import { ResearchToolchain } from './toolchain';
import { createLiteratureProviderGovernor } from './literature-provider-governor';
import type { ResearchPluginOptions } from './research-plugin-options';
import { ResearchPluginLifecycle } from './research-plugin-lifecycle';
import { createResearchPluginManifest } from './research-plugin-contract';
import { registerResearchProduction } from './research-plugin-production';
import { registerResearchWriting } from './research-plugin-writing';
import { registerResearchLiterature } from './research-plugin-literature';
import { registerResearchReview } from './research-plugin-review';
import { registerResearchWorkflow } from './research-plugin-workflow';
import { registerResearchKnowledge } from './research-plugin-knowledge';
export type { ResearchPluginOptions } from './research-plugin-options';

export function createResearchPlugin(options: ResearchPluginOptions): RocPlugin {
  const lifecycle = new ResearchPluginLifecycle();
  const toolchain = new ResearchToolchain(options.toolchainRoot ?? null, options.modelsRoot ?? null);
  const providerGovernor = createLiteratureProviderGovernor();
  const literatureService = lifecycle.own('literature', new LiteratureSearchService(options.literatureFetch, providerGovernor));
  const zotero = lifecycle.own('zotero', new ZoteroAdapter(options.zoteroFetch));
  const embeddingClient = new OpenAICompatibleEmbeddingClient(options.embeddingFetch);
  return {
    manifest: createResearchPluginManifest(),
    initialize: context => lifecycle.initialize(async () => {
      const production = registerResearchProduction(context, options, lifecycle, toolchain, embeddingClient);
      registerResearchWriting(context, options, lifecycle, production);
      const literature = await registerResearchLiterature(context, options, lifecycle, production, literatureService, providerGovernor);
      const reviewSearches = registerResearchReview(context, options, lifecycle, production, literature, zotero);
      await registerResearchWorkflow(context, options, lifecycle, production, literature, reviewSearches);
      registerResearchKnowledge(context, production);
      production.researchIndexer.start();
    }),
    shutdown: () => lifecycle.shutdown(),
    healthCheck: async () => lifecycle.health()
  };
}
