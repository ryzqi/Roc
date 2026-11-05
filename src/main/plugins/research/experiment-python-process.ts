import { join } from 'node:path';
import { z } from 'zod';
import type { ResearchExperimentStart } from '../../../shared/schemas/research-experiments';
import { pythonEnvironmentReportSchema, assertPythonCodeReceipt, type PythonCodeReceipt } from './experiment-python-code-schema';
import { pythonExperimentFlags, type InspectedPythonEnvironment } from './experiment-python-probe';
import { experimentRunnerRequestLimit } from './experiment-files';
import { researchContentHash, researchRelativePath } from './research-files';
import { ResearchProcessError, runResearchProcess, type ResearchProcessRequest, type ResearchProcessResult } from './process-runner';

const absolutePath = z.string().min(1).max(4096).startsWith('/').regex(/^[^\u0000-\u001f]+$/u);
const seedSchema = z.number().int().min(0).max(0xffff_ffff);
export const pythonExecutionStartupSchema = z.strictObject({
  sourceVersion: z.literal(1),
  report: pythonEnvironmentReportSchema.omit({ distributions: true }),
  modulePaths: z.array(absolutePath).length(4),
  sourcePath: absolutePath,
  seed: seedSchema
});
export type PythonExecutionStartup = z.infer<typeof pythonExecutionStartupSchema>;
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const pythonExecutionReportSchema = z.strictObject({
  schemaVersion: z.literal(1), runId: z.string().min(1), projectId: z.string().min(1),
  inputHash: digest, environmentHash: digest, bootstrapHash: digest, startup: pythonExecutionStartupSchema
});

/** The first stdout record is flushed before installed package or user source execution. */
export const pythonExperimentBootstrap = String.raw`import sys, os, json
request = json.loads(sys.stdin.read())
report = {
    "implementation": sys.implementation.name, "version": sys.version.split()[0],
    "platform": sys.platform, "architecture": os.uname().machine,
    "executable": sys.executable, "prefix": sys.prefix, "basePrefix": sys.base_prefix,
    "modulePaths": list(sys.path), "siteLoaded": "site" in sys.modules,
    "flags": {"isolated": sys.flags.isolated, "ignoreEnvironment": sys.flags.ignore_environment,
        "noSite": sys.flags.no_site, "noUserSite": sys.flags.no_user_site, "safePath": sys.flags.safe_path,
        "dontWriteBytecode": sys.flags.dont_write_bytecode, "utf8Mode": sys.flags.utf8_mode}
}
if report != request["startup"]:
    raise RuntimeError("research_python_startup_changed")
sys.path[:] = report["modulePaths"] + [request["packagePath"]]
source = os.path.join(request["inputDir"], request["sourcePath"])
print(json.dumps({
    "sourceVersion": request["sourceVersion"], "report": report,
    "modulePaths": list(sys.path), "sourcePath": source, "seed": request["seed"]
}, sort_keys=True), flush=True)
import types, random
random.seed(request["seed"])
context = types.ModuleType("roc_experiment")
context.source_version = request["sourceVersion"]
context.input_dir = request["inputDir"]
context.input_paths = tuple(request["inputPaths"])
context.output_dir = request["outputDir"]
context.scratch_dir = request["scratchDir"]
context.parameters = types.MappingProxyType(request["parameters"])
context.seed = request["seed"]
sys.modules["roc_experiment"] = context
sys.argv[:] = [source] + request["arguments"]
module = types.ModuleType("__main__")
module.__file__ = source
sys.modules["__main__"] = module
with open(source, "rb") as file:
    code = compile(file.read(), source, "exec", dont_inherit=True)
exec(code, module.__dict__)
`;

export function pythonExperimentBootstrapHash(): string {
  return researchContentHash(pythonExperimentBootstrap);
}

export function pythonExperimentToolchainHash(receipt: PythonCodeReceipt): string {
  return researchContentHash(JSON.stringify({
    inspectionContractVersion: receipt.metadataIdentity.inspectionContractVersion,
    probe: receipt.metadataIdentity.probe, executionContractVersion: 1,
    bootstrap: pythonExperimentBootstrapHash(), flags: pythonExperimentFlags
  }));
}

type PythonSource = Pick<ResearchExperimentStart, 'sourcePath' | 'inputPaths' | 'parameters'> & {
  sourceVersion: 1; seed: number; arguments: string[];
};
type PythonExperimentProcessInput = {
  source: PythonSource; python: InspectedPythonEnvironment;
  inputDir: string; outputDir: string; scratchDir: string;
  policy: Pick<ResearchProcessRequest, 'timeoutMs' | 'maxOutputBytes' | 'resourceLimits' | 'writeLimits'>;
  admission: ResearchProcessRequest['admission']; signal: AbortSignal;
};

/** Execute only the declared source snapshot; native policy and cleanup remain in the shared runner. */
export async function runPythonExperimentProcess(input: PythonExperimentProcessInput,
  run: (request: ResearchProcessRequest) => Promise<ResearchProcessResult> = runResearchProcess
): Promise<{ result: ResearchProcessResult; startup: PythonExecutionStartup }> {
  const { source, python, inputDir, outputDir, scratchDir, policy, admission, signal } = input;
  const receipt = assertPythonCodeReceipt(python.codeReceipt, python.metadataHash);
  const { distributions: _distributions, ...startupReport } = receipt.metadataIdentity.report;
  const { controls } = receipt.metadataIdentity;
  const wire = {
    sourceVersion: z.literal(1).parse(source.sourceVersion),
    sourcePath: researchRelativePath(source.sourcePath),
    inputPaths: source.inputPaths.map(path => researchRelativePath(path)),
    parameters: source.parameters, arguments: source.arguments, seed: seedSchema.parse(source.seed),
    inputDir: absolutePath.parse(inputDir), outputDir: absolutePath.parse(outputDir), scratchDir: absolutePath.parse(scratchDir),
    packagePath: controls.packagePath, startup: startupReport
  };
  const serialized = JSON.stringify(wire);
  if (Buffer.byteLength(serialized, 'utf8') > experimentRunnerRequestLimit) throw new ResearchProcessError('research_experiment_request_limit');
  signal.throwIfAborted();
  const result = await run({
    command: controls.selectedExecutable, args: [...pythonExperimentFlags, '-c', pythonExperimentBootstrap],
    cwd: inputDir, input: serialized,
    readablePaths: [...controls.codeRoots, ...controls.controls.map(file => file.path), inputDir],
    writablePaths: [outputDir, scratchDir],
    environment: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', TMPDIR: scratchDir },
    ...policy, admission, signal, networkAccess: 'none', allowGpuAcceleration: false
  });
  const fail = (): never => {
    const error = new ResearchProcessError('research_python_startup_report_invalid', result.stdout, result.stderr, result.resourceUsage);
    error.admission = result.admission;
    throw error;
  };
  let startup: PythonExecutionStartup;
  const newline = result.stdout.indexOf('\n');
  if (newline === -1) return fail();
  try { startup = pythonExecutionStartupSchema.parse(JSON.parse(result.stdout.slice(0, newline))); }
  catch { return fail(); }
  const expected = pythonExecutionStartupSchema.parse({
    sourceVersion: wire.sourceVersion, report: startupReport, modulePaths: [...controls.modulePaths, controls.packagePath],
    sourcePath: join(inputDir, wire.sourcePath), seed: wire.seed
  });
  if (JSON.stringify(startup) !== JSON.stringify(expected)) return fail();
  return { result, startup };
}
