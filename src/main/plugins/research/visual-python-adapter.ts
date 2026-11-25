import {mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import type {ResearchPythonEnvironmentService, PythonRuntimeLease} from './python-environment-service';
import {assertPythonCodeReceipt} from './experiment-python-code-schema';
import {pythonExperimentFlags} from './experiment-python-probe';
import {readResearchFile} from './research-files';
import {runResearchProcess} from './process-runner';
import {inspectVisualModel} from './visual-model-files';
import {decodeVisualMatrix, type VisualRetrievalAdapter, type VisualMatrix} from './visual-retrieval-adapter';

export const visualPythonBootstrap = String.raw`import sys, os, json
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
print(json.dumps(report, sort_keys=True), flush=True)
sys.path[:] = report["modulePaths"] + [request["packagePath"]]
import torch, numpy as np
from PIL import Image
from sentence_transformers import MultiVectorEncoder
torch.set_num_threads(2)
torch.set_num_interop_threads(1)
model = MultiVectorEncoder(request["modelPath"], local_files_only=True,
    trust_remote_code=False, device="cpu", model_kwargs={"use_safetensors": True})
rows = []
count = 1 if request["query"] is not None else request["images"]
with torch.inference_mode():
    for i in range(count):
        if request["query"] is not None:
            matrix = model.encode_query([request["query"]], convert_to_numpy=True,
                normalize_embeddings=True, show_progress_bar=False)[0]
        else:
            with Image.open(os.path.join(request["inputDir"], str(i) + ".png")) as image:
                matrix = model.encode_document([image.convert("RGB")], batch_size=1,
                    convert_to_numpy=True, normalize_embeddings=True, show_progress_bar=False)[0]
        matrix = np.asarray(matrix, dtype="<f4")
        limit = 256 if request["query"] is not None else 4096
        if matrix.ndim != 2 or not 1 <= matrix.shape[0] <= limit or not 1 <= matrix.shape[1] <= 512:
            raise RuntimeError("research_visual_matrix_shape_invalid")
        if not np.isfinite(matrix).all():
            raise RuntimeError("research_visual_matrix_value_invalid")
        with open(os.path.join(request["outputDir"], str(i) + ".f32"), "xb") as file:
            file.write(matrix.tobytes(order="C"))
        rows.append({"tokens": matrix.shape[0], "dimensions": matrix.shape[1]})
with open(os.path.join(request["outputDir"], "result.json"), "x") as file:
    json.dump(rows, file)
del model
`;
const rowsSchema = z.array(z.strictObject({tokens: z.number().int().min(1).max(4096),
  dimensions: z.number().int().min(1).max(512)})).min(1).max(32);

export class PythonVisualRetrievalAdapter implements VisualRetrievalAdapter {
  constructor(private readonly environments: Pick<ResearchPythonEnvironmentService, 'acquireRuntime'>,
    private readonly run: typeof runResearchProcess = runResearchProcess) {}
  async encode(input: Parameters<VisualRetrievalAdapter['encode']>[0], signal: AbortSignal): Promise<{matrices: VisualMatrix[]; assertCurrent: () => void}> {
    signal.throwIfAborted();
    if (input.query === null ? input.images.length < 1 || input.images.length > 32 : input.images.length !== 0 || !input.query.trim() || input.query.length > 2048) {
      throw new Error('research_visual_input_invalid');
    }
    if (input.images.reduce((n, b) => n + b.length, 0) > 128 * 1024 ** 2) throw new Error('research_visual_input_budget_exceeded');
    const job = await realpath(await mkdtemp(join(tmpdir(), 'roc-visual-')));
    const admission = {projectId: input.projectId, priority: 'background' as const, resourceClass: 'compute' as const};
    let lease: PythonRuntimeLease | undefined;
    try {
      const model = await inspectVisualModel(input.model.path, input.model.family, signal);
      if (model.sha256 !== input.model.sha256) throw new Error('research_visual_model_changed');
      const environmentRef = {projectId: input.projectId, environmentId: input.model.environmentId, expectedHash: input.model.environmentHash};
      lease = await this.environments.acquireRuntime(environmentRef, job, signal, admission, () => undefined);
      const python = lease.environment;
      const receipt = assertPythonCodeReceipt(python.codeReceipt, python.metadataHash);
      if (python.report.distributions.find(d => d.name === 'sentence-transformers')?.version !== '6.0.1') {
        throw new Error('research_visual_engine_version_unsupported');
      }
      const {distributions: _, ...startup} = receipt.metadataIdentity.report, {controls} = receipt.metadataIdentity;
      const inputDir = join(job, 'input'), outputDir = join(job, 'output'), scratchDir = join(job, 'scratch');
      for (const dir of [inputDir, outputDir, scratchDir]) await mkdir(dir);
      for (const [i, bytes] of input.images.entries()) await writeFile(join(inputDir, `${i}.png`), bytes, {flag: 'wx', mode: 0o600});
      model.assertCurrent(); signal.throwIfAborted();
      const result = await this.run({command: controls.selectedExecutable,
        args: [...pythonExperimentFlags, '-c', visualPythonBootstrap], cwd: inputDir,
        input: JSON.stringify({startup, packagePath: controls.packagePath, modelPath: input.model.path,
          query: input.query, images: input.images.length, inputDir, outputDir}),
        readablePaths: [...controls.codeRoots, ...controls.controls.map(f => f.path), input.model.path, inputDir],
        writablePaths: [outputDir, scratchDir], environment: {PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8',
          TMPDIR: scratchDir, HF_HOME: scratchDir, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
          TOKENIZERS_PARALLELISM: 'false', OMP_NUM_THREADS: '2', VECLIB_MAXIMUM_THREADS: '2'},
        timeoutMs: 300_000, maxOutputBytes: 1024 ** 2,
        resourceLimits: {mode: 'monitored', cpuTimeMs: 600_000, maxResidentBytes: 8 * 1024 ** 3},
        writeLimits: [{path: outputDir, maxFileBytes: 8 * 1024 ** 2, maxTotalBytes: 257 * 1024 ** 2, maxFiles: 33, maxEntries: 33},
          {path: scratchDir, maxFileBytes: 16 * 1024 ** 2, maxTotalBytes: 32 * 1024 ** 2, maxFiles: 128, maxEntries: 256}],
        admission, signal, networkAccess: 'none', allowGpuAcceleration: false});
      signal.throwIfAborted();
      if (result.exitCode !== 0) throw new Error('research_visual_inference_failed');
      let report: unknown;
      try {report = JSON.parse(result.stdout.split('\n')[0]!);} catch {throw new Error('research_visual_startup_invalid');}
      if (!isDeepStrictEqual(report, startup)) throw new Error('research_visual_startup_invalid');
      const rows = rowsSchema.parse(JSON.parse((await readResearchFile(outputDir, 'result.json', 65536)).toString('utf8')));
      if (rows.length !== (input.query === null ? input.images.length : 1)) throw new Error('research_visual_matrix_count_invalid');
      const matrices: VisualMatrix[] = [];
      for (const [i, shape] of rows.entries()) matrices.push(decodeVisualMatrix(await readResearchFile(outputDir, `${i}.f32`, 8 * 1024 ** 2), shape));
      await lease.verify(() => undefined);
      model.assertCurrent(); return {matrices, assertCurrent: model.assertCurrent};
    } finally {
      lease?.release();
      // runResearchProcess settles its process tree and shared resource lease before returning/rejecting.
      await rm(job, {recursive: true, force: true});
    }
  }
}
