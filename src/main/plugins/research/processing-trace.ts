import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {RocPluginContext} from '../../kernel/types';

const identity = z.string().min(1).max(300).nullable();
const digest = z.string().regex(/^[a-f0-9]{64}$/u).nullable();
const relatedPaperSchema = z.object({paper_id: identity, document_id: identity, source_hash: digest,
  parse_id: identity, parser_fingerprint: digest}).strict();
export const processingTraceContextSchema = z.object({
  trace_id: z.string().min(1).max(300),
  project_id: identity, paper_id: identity, document_id: identity,
  source_hash: digest, parse_id: identity, parser_fingerprint: digest,
  paper_ir_version: identity, chunk_version: identity,
  embedding_config_revision: identity, index_generation: identity, wiki_generation: identity,
  related_papers: z.array(relatedPaperSchema).max(50).default([])
}).strict();
export type ProcessingTraceContext = z.infer<typeof processingTraceContextSchema>;
const stages = ['index_job', 'document_processing', 'source_read', 'document_parse', 'native_text_extract', 'visual_inspection',
  'layout_inference', 'ocr_inference', 'table_reconstruction', 'formula_recognition',
  'paper_ir_build', 'semantic_classification', 'scholarly_parse', 'chunk_generation', 'embedding', 'index_publish',
  'paper_card_generation', 'scientific_extraction', 'entity_extraction', 'fact_extraction',
  'relation_extraction', 'extraction_publish', 'wiki_compile'] as const;
export type ProcessingStage = typeof stages[number];
const count = z.number().int().nonnegative().nullable();
export const processingStageEventSchema = z.object({
  schemaVersion: z.literal(1), context: processingTraceContextSchema,
  stage: z.enum(stages), spanId: z.string().uuid(), state: z.enum(['started', 'ready', 'failed']),
  page: z.number().int().positive().nullable(),
  startedAt: z.string().datetime(), finishedAt: z.string().datetime().nullable(),
  durationMs: z.number().nonnegative().nullable(), activeDurationMs: z.number().nonnegative().nullable(),
  inputCount: count, outputCount: count, unit: z.enum(['bytes', 'pages', 'blocks', 'chunks', 'vectors', 'sections', 'model_calls']).nullable(),
  failureCode: z.string().regex(/^(?:research_|wiki_|embedding_)[a-z0-9_]{1,180}$/u).nullable(),
  resources: z.object({scope: z.literal('process'), pid: z.number().int().positive(),
    residentBytes: z.number().int().nonnegative(), lifetimePeakResidentBytes: z.number().int().nonnegative(),
    cpuUserMicros: z.number().int().nonnegative(), cpuSystemMicros: z.number().int().nonnegative()
  }).strict()
}).strict().superRefine((event, ctx) => {
  if (event.state === 'started' ? event.finishedAt !== null || event.durationMs !== null || event.failureCode !== null
    : event.finishedAt === null || event.durationMs === null || (event.state === 'failed') !== (event.failureCode !== null)) {
    ctx.addIssue({code: 'custom', message: 'research_processing_event_state_invalid'});
  }
});
export type ProcessingStageEvent = z.infer<typeof processingStageEventSchema>;
type Counts = Pick<ProcessingStageEvent, 'inputCount' | 'outputCount' | 'unit'>;
type Span = {finish(error?: unknown, counts?: Partial<Counts>, activeDurationMs?: number | null): void; fail(error: unknown): void};
export const processingTraceWirePrefix = 'roc_processing_stage:';

export function processingFailureCode(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'research_process_cancelled';
  const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code
    : error instanceof Error && /^(research_|wiki_|embedding_)/u.test(error.message) ? error.message : 'research_processing_failed';
  return /^(?:research_|wiki_|embedding_)[a-z0-9_]{1,180}$/u.test(code) ? code : 'research_processing_failed';
}

/** No source text, model output or credentials enter the event contract. */
export class ResearchProcessingObserver {
  constructor(private readonly logger?: Pick<RocPluginContext['logger'], 'info' | 'warn'>) {}
  trace(context: Partial<ProcessingTraceContext> & {trace_id: string}): ResearchProcessingTrace {
    return new ResearchProcessingTrace(processingTraceContextSchema.parse({
      project_id: null, paper_id: null, document_id: null, source_hash: null, parse_id: null,
      parser_fingerprint: null, paper_ir_version: null, chunk_version: null,
      embedding_config_revision: null, index_generation: null, wiki_generation: null, ...context
    }), event => this.emit(event));
  }
  emit(event: ProcessingStageEvent): void {
    if (event.state === 'failed') this.logger?.warn('research_processing_stage', event);
    else this.logger?.info('research_processing_stage', event);
  }
}

export class ResearchProcessingTrace {
  private readonly models = new Map<string, {span: Span; calls: number; completed: number; activeMs: number; error?: unknown}>();
  page: number | null = null;
  constructor(public context: ProcessingTraceContext, private readonly sink: (event: ProcessingStageEvent) => void) {}
  bind(context: Partial<Omit<ProcessingTraceContext, 'trace_id'>>): void {
    this.context = processingTraceContextSchema.parse({...this.context, ...context});
  }
  start(stage: ProcessingStage, counts: Partial<Counts> = {}, page: number | null = this.page): Span {
    const startedAt = new Date().toISOString(), clock = performance.now(), cpu = process.cpuUsage(), spanId = randomUUID();
    const initial = {inputCount: null, outputCount: null, unit: null, ...counts};
    const resources = (delta: boolean): ProcessingStageEvent['resources'] => {
      const usage = delta ? process.cpuUsage(cpu) : {user: 0, system: 0};
      return {scope: 'process', pid: process.pid, residentBytes: process.memoryUsage.rss(),
        lifetimePeakResidentBytes: process.resourceUsage().maxRSS * 1024,
        cpuUserMicros: usage.user, cpuSystemMicros: usage.system};
    };
    this.sink({schemaVersion: 1, context: {...this.context}, stage, spanId, state: 'started', page,
      startedAt, finishedAt: null, durationMs: null, activeDurationMs: null, ...initial,
      failureCode: null, resources: resources(false)});
    let finished = false;
    const finish: Span['finish'] = (error, measured = {}, activeDurationMs = null) => {
      if (finished) return;
      finished = true;
      this.sink({schemaVersion: 1, context: {...this.context}, stage, spanId, state: error === undefined ? 'ready' : 'failed',
        page, startedAt, finishedAt: new Date().toISOString(), durationMs: Math.max(0, performance.now() - clock),
        activeDurationMs, ...initial, ...measured, failureCode: error === undefined ? null : processingFailureCode(error),
        resources: resources(true)});
    };
    return {finish, fail: error => finish(error === undefined ? new Error('research_processing_failed') : error)};
  }
  async run<T>(stage: ProcessingStage, operation: () => Promise<T>, counts: Partial<Counts> = {},
    outputCount?: (result: T) => number): Promise<T> {
    const span = this.start(stage, counts);
    try {const result = await operation(); span.finish(undefined, outputCount ? {outputCount: outputCount(result)} : {}); return result;}
    catch (error) {span.fail(error); throw error;}
  }
  sync<T>(stage: ProcessingStage, operation: () => T, counts: Partial<Counts> = {},
    outputCount?: (result: T) => number): T {
    const span = this.start(stage, counts);
    try {const result = operation(); span.finish(undefined, outputCount ? {outputCount: outputCount(result)} : {}); return result;}
    catch (error) {span.fail(error); throw error;}
  }
  /** Aggregate autoregressive model calls per page, keeping the worker wire bounded. */
  async modelRun<T>(stage: ProcessingStage, operation: () => Promise<T>): Promise<T> {
    const key = `${stage}:${this.page}`;
    let model = this.models.get(key);
    if (!model) {model = {span: this.start(stage, {unit: 'model_calls'}), calls: 0, completed: 0, activeMs: 0}; this.models.set(key, model);}
    const clock = performance.now();
    model.calls++;
    try {const result = await operation(); model.completed++; return result;}
    catch (error) {model.error = error === undefined ? new Error('research_processing_failed') : error; throw error;}
    finally {model.activeMs += performance.now() - clock;}
  }
  flushModels(error?: unknown): void {
    for (const model of this.models.values()) model.span.finish(model.error !== undefined ? model.error : error,
      {inputCount: model.calls, outputCount: model.completed}, model.activeMs);
    this.models.clear();
  }
  forwardWorker(stderr: string): void {
    for (const line of stderr.split('\n')) {
      if (!line.startsWith(processingTraceWirePrefix)) continue;
      let value: unknown;
      try {value = JSON.parse(line.slice(processingTraceWirePrefix.length));}
      catch {throw new Error('research_processing_trace_invalid');}
      const parsed = processingStageEventSchema.safeParse(value);
      if (!parsed.success || ['trace_id', 'project_id', 'paper_id', 'document_id', 'parse_id'].some(
        key => parsed.data?.context[key as keyof ProcessingTraceContext] !== this.context[key as keyof ProcessingTraceContext])
        || (this.context.source_hash !== null && parsed.data.context.source_hash !== this.context.source_hash)) {
        throw new Error('research_processing_trace_invalid');
      }
      this.sink(parsed.data);
    }
  }
}
