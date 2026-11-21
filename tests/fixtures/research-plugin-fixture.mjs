import { build } from 'esbuild';
import Database from 'better-sqlite3';
import { mkdtemp, readFile, rm, mkdir, cp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const constructed = [
  'ResearchDiagramService', 'ResearchProseLintService', 'ReferenceCheckService', 'ReadingRepository',
  'RadarService', 'ReadingTranslationService', 'ReadingDiscoveryService', 'ScholarlyRelationsService',
  'OpenReviewService', 'HuggingFaceService', 'HuggingFaceDownloadService', 'ResearchResourceService',
  'ResearchMonitorService', 'ResearchDocumentService', 'ResearchReviewCorpusRepository',
  'ResearchReviewDeduplicationRepository', 'ResearchReviewScreeningRepository',
  'ResearchReviewScreeningDecisions', 'ResearchReviewScreeningArbitration', 'ResearchReviewScreeningFreeze',
  'ResearchReviewFullTextRepository', 'ResearchReviewFullTextScreening', 'ResearchReviewFullTextArbitration',
  'ResearchReviewFullTextFreeze', 'ResearchReviewExtractionRepository', 'ResearchReviewQualityPlanRepository',
  'ResearchReviewQualityAssessmentRepository', 'ResearchReviewStudiesRepository', 'ResearchReviewReportService'
];

export async function loadResearchPluginApi({ observe = false, productionWorkers = false } = {}) {
  const directory = join(process.cwd(), '.runtime', 'tmp', `research-plugin-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const outfile = join(directory, 'api.mjs');
  try {
    if (productionWorkers) await cp(join(process.cwd(), 'dist/main'), directory, { recursive: true });
    await build({
      stdin: { contents: `
        export { createResearchPlugin } from './src/main/plugins/research/index';
        export { CapabilityRegistry } from './src/main/kernel/capability-registry';
        export { ResearchRepository } from './src/main/plugins/research/repository';
        export { ResearchTaskRepository } from './src/main/plugins/research/research-task-repository';
        export { ExecutionGrantBroker } from './src/main/services/deep-agent/execution-grant-broker';
        export { RunUsageLedger } from './src/main/services/deep-agent/run-usage-ledger';
        export { applyResearchDatabaseSchema, applyAgentDatabaseSchema } from './src/main/infrastructure/database-schemas';
        export { ResearchMonitorRepository } from './src/main/plugins/research/monitor-repository';
        export { ResearchMonitorService } from './src/main/plugins/research/monitor-service';
        export { sealMonitor } from './src/main/plugins/research/monitor-repository';
        export { HuggingFaceRepository } from './src/main/plugins/research/huggingface-repository';
        export { HuggingFaceService } from './src/main/plugins/research/huggingface-service';
        export { HuggingFaceDownloadRepository } from './src/main/plugins/research/huggingface-download-repository';
        export { huggingFaceDownloadDirectory } from './src/main/plugins/research/huggingface-download-service';
        export { LiteratureSearchService } from './src/main/plugins/research/literature-service';
        export { withResearchHumanContext } from './src/main/services/research-human-context';
      `, resolveDir: process.cwd(), loader: 'ts' },
      outfile, bundle: true, format: 'esm', platform: 'node', packages: 'external',
      loader: { '.md': 'text', '.c': 'text' }, logLevel: 'silent',
      plugins: [{
        name: 'source-driven-research-fixture',
        setup(builder) {
          // Native panels are outside this Node fixture. Electron smoke exercises the real dialog module.
          builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture-native-dialog' }));
          builder.onLoad({ filter: /.*/, namespace: 'fixture-native-dialog' }, () => ({
            contents: `export const dialog = { showSaveDialog() { throw new Error('fixture_native_dialog_not_available'); } };
              export const app = { getAppPath() { return process.cwd(); } };`,
            loader: 'js'
          }));
          builder.onLoad({ filter: /plugins\/research\/(?:index|research-plugin-[^/]+)\.ts$/ }, async args => {
            let contents = await readFile(args.path, 'utf8');
            if (observe) {
              // Constructors moved into domain units; instrument only actual constructor sites.
              const names = constructed.filter(name => contents.includes(`new ${name}(`));
              const wrappers = names.map(name =>
                `const __observe${name} = new Proxy(${name}, { construct(target, args) {
                  const counts = globalThis.__rocResearchStartupConstructed;
                  counts[name] = (counts[name] ?? 0) + 1;
                  return Reflect.construct(target, args, target);
                } });`.replace('counts[name]', `counts['${name}']`).replace('counts[name]', `counts['${name}']`)).join('\n');
              for (const name of names) contents = contents.replaceAll(`new ${name}(`, `new __observe${name}(`);
              contents += `\n${wrappers}`;
            }
            return { contents, loader: 'ts', resolveDir: dirname(args.path) };
          });
        }
      }]
    });
    const api = await import(pathToFileURL(outfile).href);
    return { ...api, dispose: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function createResearchPluginFixture(api, { root, observe = false, fetchImpl, databasePath } = {}) {
  const directory = root ?? await mkdtemp(join(process.cwd(), '.runtime', 'tmp', 'research-profile-'));
  const db = new Database(databasePath ?? ':memory:'), agentDb = new Database(':memory:');
  if (databasePath !== undefined) db.pragma('journal_mode=WAL');
  db.pragma('foreign_keys = ON'); agentDb.pragma('foreign_keys = ON');
  api.applyResearchDatabaseSchema(db); api.applyAgentDatabaseSchema(agentDb);
  const tasks = new api.ResearchTaskRepository(agentDb);
  const repository = new api.ResearchRepository(db, tasks);
  const registry = new api.CapabilityRegistry();
  const observations = [], requests = [];
  const config = new Map();
  let sqlCalls = 0;
  const observedDb = observe ? new Proxy(db, { get(target, key) {
    if (key === 'prepare') return sql => {
      const statement = target.prepare(sql);
      const observedStatement = new Proxy(statement, { get(stmt, operation) {
        const value = Reflect.get(stmt, operation, stmt);
        if (typeof value !== 'function') return value;
        return (...args) => {
          if (['get', 'all', 'run', 'iterate'].includes(operation)) sqlCalls++;
          const result = Reflect.apply(value, stmt, args);
          return result === stmt ? observedStatement : result;
        };
      } });
      return observedStatement;
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) : db;
  const plugin = api.createResearchPlugin({
    resourceRoot: join(directory, 'resources'), diagnosticsRoot: join(directory, 'diagnostics'),
    executionGrantBroker: new api.ExecutionGrantBroker(agentDb), tasks,
    usageLedger: new api.RunUsageLedger(agentDb),
    roleExecutor: { prepare() { throw new Error('fixture_model_call_not_expected'); } },
    modelFactory: {
      defaultChatModelStamp() { return 'a'.repeat(64); },
      createDefaultChatModel() { throw new Error('fixture_model_call_not_expected'); }
    },
    literatureFetch: async (url, init) => {
      requests.push(String(url));
      if (fetchImpl !== undefined) return fetchImpl(url, init);
      throw new Error('fixture_network_call_not_expected');
    }
  });
  for (const descriptor of plugin.manifest.capabilities) registry.declare(plugin.manifest.id, descriptor);
  const context = {
    pluginId: plugin.manifest.id, capabilities: registry,
    database: { getConnection: () => observedDb },
    config: { get: key => config.get(key) ?? null, set: (key, value) => { config.set(key, value); } },
    secrets: { get: async () => null, set: async () => {}, clear() {} },
    logger: { info: (message, metadata) => observations.push({ message, metadata }), warn() {}, error() {} },
    eventBus: { publish: async () => {}, subscribe: () => () => {} }
  };
  return {
    directory, db, agentDb, tasks, repository, registry, plugin, context, observations, requests,
    sqlCalls: () => sqlCalls,
    initialize: () => plugin.initialize(context),
    close: async () => {
      try { await plugin.shutdown(); } finally {
        db.close(); agentDb.close();
        if (root === undefined) await rm(directory, { recursive: true, force: true });
      }
    }
  };
}
