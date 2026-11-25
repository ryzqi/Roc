import type { LangChainModelFactory } from '../../services/langchain-model-factory';
import type { ExecutionGrantBroker } from '../../services/deep-agent/execution-grant-broker';
import type { ResearchTaskRepository } from './research-task-repository';
import type { RunUsageLedger } from '../../services/deep-agent/run-usage-ledger';
import type { OpenAICompatibleEmbeddingClient } from './embedding-client';
import type { LiteratureSearchService } from './literature-service';
import type { ZoteroAdapter } from './zotero-adapter';
import type { ResearchLibraryService } from './library-service';
import type { ResearchIndexWatch } from './index-service';
import type { ResearchRoleExecutor } from './role-executor';
import type {ScholarlyParserAdapter} from './scholarly-parser-adapter';

export type ResearchPluginOptions = {
  resourceRoot: string;
  executionGrantBroker: ExecutionGrantBroker;
  tasks: ResearchTaskRepository;
  usageLedger: RunUsageLedger;
  pythonRoot: string;
  experimentRoot?: string;
  exportRoot?: string;
  diagnosticsRoot: string;
  indexRoot?: string;
  indexWatch?: ResearchIndexWatch;
  libraryRoot?: string;
  /** 文稿检查的私有 job 根目录：投影文件与 Vale 的 HOME/缓存都写在里面，跑完即删。 */
  proseRoot?: string;
  libraryFetch?: ConstructorParameters<typeof ResearchLibraryService>[3];
  toolchainRoot?: string;
  modelsRoot?: string;
  /** Optional local scholarly parser; stays disabled until measured benefit supports activation. */
  scholarlyParser?: ScholarlyParserAdapter;
  roleExecutor: ResearchRoleExecutor;
  modelFactory: Pick<LangChainModelFactory, 'createDefaultChatModel' | 'defaultChatModelStamp'>;
  literatureFetch?: ConstructorParameters<typeof LiteratureSearchService>[0];
  zoteroFetch?: ConstructorParameters<typeof ZoteroAdapter>[0];
  embeddingFetch?: ConstructorParameters<typeof OpenAICompatibleEmbeddingClient>[0];
};
