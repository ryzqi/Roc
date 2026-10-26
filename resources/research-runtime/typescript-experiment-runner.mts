import { createReadStream } from 'node:fs';
import { mkdir, lstat, open, readFile, realpath } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_CSV_RECORD_BYTES = 1024 * 1024;
const MAX_INPUT_FILE_BYTES = 64 * 1024 * 1024;
const MAX_INPUT_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_OUTPUT_FILE_BYTES = 64 * 1024 * 1024;
const MAX_OUTPUT_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_OUTPUT_FILES = 1000;
const MAX_CSV_ROWS = 100_000;
const decoder = new TextDecoder('utf-8', { fatal: true });

type RunnerLimits = {
  inputFileBytes: number;
  totalInputBytes: number;
  csvRows: number;
  outputFileBytes: number;
  totalOutputBytes: number;
  outputFiles: number;
};

type RunnerRequest = {
  contractVersion: 1;
  sourcePath: string;
  inputPaths: string[];
  inputDir: string;
  outputDir: string;
  parameters: Record<string, unknown>;
  packageEntries: Record<string, string>;
  limits: RunnerLimits;
};

type CsvValue = string | number | boolean | null | undefined;
type CsvRecord = Record<string, CsvValue>;
type CsvParseOptions = {
  bom: true;
  columns: true;
  delimiter: string;
  max_record_size: number;
  skip_empty_lines: true;
  relax_column_count: false;
};
type CsvParseFunction = (options: CsvParseOptions) => Transform & AsyncIterable<Record<string, string>>;
type CsvFormatFunction = (rows: CsvRecord[], columns: string[]) => string;
type ResearchStatistics = Pick<typeof import('simple-statistics'), 'mean' | 'median' | 'quantile' | 'variance' | 'standardDeviation' | 'sampleCorrelation' | 'linearRegression'>;
type ResearchExperimentContext = {
  contractVersion: 1;
  parameters: Readonly<Record<string, unknown>>;
  inputPaths: readonly string[];
  signal: AbortSignal;
  files: {
    readText(path: string): Promise<string>;
    readCsv(path: string, options?: { delimiter?: string }): Promise<Record<string, string>[]>;
    writeText(path: string, content: string): Promise<void>;
    writeCsv(path: string, rows: unknown, options?: { columns?: string[] }): Promise<void>;
  };
  statistics: ResearchStatistics;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= maximum;
}

function parseRequest(value: unknown): RunnerRequest {
  if (!isRecord(value) || value.contractVersion !== 1 || typeof value.sourcePath !== 'string' ||
      typeof value.inputDir !== 'string' || typeof value.outputDir !== 'string' || !Array.isArray(value.inputPaths) ||
      value.inputPaths.length > 500 || !isRecord(value.parameters) || !isRecord(value.packageEntries) || !isRecord(value.limits)) {
    throw new Error('research_experiment_request_invalid');
  }
  const { inputFileBytes, totalInputBytes, csvRows, outputFileBytes, totalOutputBytes, outputFiles } = value.limits;
  if (!positiveInteger(inputFileBytes, MAX_INPUT_FILE_BYTES) || !positiveInteger(totalInputBytes, MAX_INPUT_TOTAL_BYTES) ||
      !positiveInteger(csvRows, MAX_CSV_ROWS) || !positiveInteger(outputFileBytes, MAX_OUTPUT_FILE_BYTES) ||
      !positiveInteger(totalOutputBytes, MAX_OUTPUT_TOTAL_BYTES) || !positiveInteger(outputFiles, MAX_OUTPUT_FILES)) {
    throw new Error('research_experiment_limits_invalid');
  }
  const packageEntries: Record<string, string> = {};
  for (const name of ['csv-parse', 'd3-dsv', 'simple-statistics']) {
    const entry = value.packageEntries[name];
    if (typeof entry !== 'string' || !isAbsolute(entry)) throw new Error('research_experiment_package_invalid');
    packageEntries[name] = entry;
  }
  return {
    contractVersion: 1,
    sourcePath: value.sourcePath,
    inputPaths: value.inputPaths.map((path) => {
      if (typeof path !== 'string') throw new Error('research_experiment_path_invalid');
      return path;
    }),
    inputDir: value.inputDir,
    outputDir: value.outputDir,
    parameters: value.parameters,
    packageEntries,
    limits: { inputFileBytes, totalInputBytes, csvRows, outputFileBytes, totalOutputBytes, outputFiles }
  };
}

async function readStdin(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_REQUEST_BYTES) throw new Error('research_experiment_request_limit');
    chunks.push(bytes);
  }
  const input = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(input) as unknown;
  } catch {
    throw new Error('research_experiment_request_invalid');
  }
}

function assertRelative(path: string): string {
  if (path.length === 0 || path.includes('\\') || path.includes('\0') || isAbsolute(path)) throw new Error('research_experiment_path_invalid');
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) throw new Error('research_experiment_path_invalid');
  return path;
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function safeInput(root: string, path: string, allowed: ReadonlySet<string>, maxFileBytes: number): Promise<{ path: string; size: number }> {
  assertRelative(path);
  if (!allowed.has(path)) throw new Error('research_experiment_input_not_declared');
  const target = resolve(root, path);
  const before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxFileBytes) throw new Error('research_experiment_input_invalid');
  const actual = await realpath(target);
  if (!inside(root, actual)) throw new Error('research_experiment_input_invalid');
  return { path: actual, size: before.size };
}

async function loadModule(path: string): Promise<Record<string, unknown>> {
  const loaded = await import(pathToFileURL(path).href) as Record<string, unknown>;
  const defaultValue = loaded.default;
  return isRecord(defaultValue) ? { ...defaultValue, ...loaded } : loaded;
}

async function main(): Promise<void> {
  const request = parseRequest(await readStdin());
  const inputRoot = await realpath(request.inputDir);
  const outputRoot = await realpath(request.outputDir);
  const allowedInputs = new Set([assertRelative(request.sourcePath), ...request.inputPaths.map(assertRelative)]);
  const csvModule = await loadModule(request.packageEntries['csv-parse']);
  const dsvModule = await loadModule(request.packageEntries['d3-dsv']);
  const statisticsModule = await loadModule(request.packageEntries['simple-statistics']);
  if (typeof csvModule.parse !== 'function' || typeof dsvModule.csvFormat !== 'function') throw new Error('research_experiment_package_invalid');
  const parseCsv = csvModule.parse as CsvParseFunction;
  const csvFormat = dsvModule.csvFormat as CsvFormatFunction;
  const inputUsage = { bytes: 0 };
  const outputUsage = { bytes: 0, files: 0 };

  async function readInput(path: string, limit: number): Promise<Buffer> {
    const file = await safeInput(inputRoot, path, allowedInputs, request.limits.inputFileBytes);
    inputUsage.bytes += file.size;
    if (file.size > limit || inputUsage.bytes > request.limits.totalInputBytes) throw new Error('research_experiment_input_limit');
    return readFile(file.path);
  }

  async function readText(path: string): Promise<string> {
    return decoder.decode(await readInput(path, request.limits.inputFileBytes));
  }

  async function readCsv(path: string, options: { delimiter?: string } = {}): Promise<Record<string, string>[]> {
    const file = await safeInput(inputRoot, path, allowedInputs, request.limits.inputFileBytes);
    inputUsage.bytes += file.size;
    if (file.size > request.limits.inputFileBytes || inputUsage.bytes > request.limits.totalInputBytes) throw new Error('research_experiment_input_limit');
    const delimiter = options.delimiter ?? (extname(path).toLowerCase() === '.tsv' ? '\t' : ',');
    if (delimiter.length !== 1) throw new Error('research_experiment_delimiter_invalid');
    const parser = parseCsv({ bom: true, columns: true, delimiter, max_record_size: MAX_CSV_RECORD_BYTES,
      skip_empty_lines: true, relax_column_count: false });
    const rows: Record<string, string>[] = [];
    createReadStream(file.path).pipe(parser);
    for await (const row of parser) {
      if (rows.length >= request.limits.csvRows) throw new Error('research_experiment_row_limit');
      rows.push(row);
    }
    return rows;
  }

  async function outputPath(path: string): Promise<string> {
    assertRelative(path);
    const target = resolve(outputRoot, path);
    const parent = dirname(target);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const actualParent = await realpath(parent);
    if (!inside(outputRoot, actualParent)) throw new Error('research_experiment_output_invalid');
    try {
      await lstat(target);
      throw new Error('research_experiment_output_exists');
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    return target;
  }

  async function writeText(path: string, content: string): Promise<void> {
    if (typeof content !== 'string') throw new Error('research_experiment_output_invalid');
    const bytes = Buffer.from(content, 'utf8');
    if (bytes.length > request.limits.outputFileBytes || outputUsage.files >= request.limits.outputFiles ||
        outputUsage.bytes + bytes.length > request.limits.totalOutputBytes) throw new Error('research_experiment_output_limit');
    const target = await outputPath(path);
    const file = await open(target, 'wx', 0o600);
    try { await file.writeFile(bytes); }
    finally { await file.close(); }
    outputUsage.bytes += bytes.length;
    outputUsage.files += 1;
  }

  async function writeCsv(path: string, rows: unknown, options: { columns?: string[] } = {}): Promise<void> {
    if (!Array.isArray(rows) || rows.length > request.limits.csvRows) throw new Error('research_experiment_row_limit');
    const columns = options.columns ?? (rows.length > 0 && isRecord(rows[0]) ? Object.keys(rows[0]) : []);
    if (columns.length === 0 || columns.length > 1000 ||
        columns.some((column) => typeof column !== 'string' || column.length === 0) || new Set(columns).size !== columns.length) {
      throw new Error('research_experiment_csv_columns_invalid');
    }
    const records: CsvRecord[] = rows.map((row) => {
      if (!isRecord(row)) throw new Error('research_experiment_csv_row_invalid');
      for (const column of columns) {
        const value = row[column];
        if (value !== null && value !== undefined && !['string', 'number', 'boolean'].includes(typeof value)) {
          throw new Error('research_experiment_csv_row_invalid');
        }
      }
      return row as CsvRecord;
    });
    await writeText(path, csvFormat(records, columns));
  }

  const statisticNames = ['mean', 'median', 'quantile', 'variance', 'standardDeviation', 'sampleCorrelation', 'linearRegression'] as const;
  if (statisticNames.some((name) => typeof statisticsModule[name] !== 'function')) throw new Error('research_experiment_package_invalid');
  const statistics: ResearchStatistics = Object.freeze({
    mean: statisticsModule.mean as ResearchStatistics['mean'],
    median: statisticsModule.median as ResearchStatistics['median'],
    quantile: statisticsModule.quantile as ResearchStatistics['quantile'],
    variance: statisticsModule.variance as ResearchStatistics['variance'],
    standardDeviation: statisticsModule.standardDeviation as ResearchStatistics['standardDeviation'],
    sampleCorrelation: statisticsModule.sampleCorrelation as ResearchStatistics['sampleCorrelation'],
    linearRegression: statisticsModule.linearRegression as ResearchStatistics['linearRegression']
  });
  const controller = new AbortController();
  const onSignal = () => controller.abort(new Error('research_experiment_cancelled'));
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  const context: ResearchExperimentContext = Object.freeze({
    contractVersion: 1,
    parameters: Object.freeze({ ...request.parameters }),
    inputPaths: Object.freeze([...request.inputPaths]),
    signal: controller.signal,
    files: Object.freeze({ readText, readCsv, writeText, writeCsv }),
    statistics: Object.freeze(statistics)
  });
  try {
    const source = await safeInput(inputRoot, request.sourcePath, allowedInputs, request.limits.inputFileBytes);
    inputUsage.bytes += source.size;
    if (source.size > request.limits.inputFileBytes || inputUsage.bytes > request.limits.totalInputBytes) throw new Error('research_experiment_source_limit');
    const module = await import(pathToFileURL(source.path).href) as { run?: (context: ResearchExperimentContext) => unknown };
    if (typeof module.run !== 'function') throw new Error('research_experiment_run_export_required');
    const result = await module.run(context);
    if (result !== undefined) throw new Error('research_experiment_return_value_unsupported');
    if (outputUsage.bytes > request.limits.totalOutputBytes || outputUsage.files > request.limits.outputFiles) throw new Error('research_experiment_output_limit');
  } finally {
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'research_experiment_failed'}\n`);
  process.exitCode = 1;
});
