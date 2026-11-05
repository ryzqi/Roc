import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { ResearchExperimentEnvironment } from '../../../shared/schemas/research-experiments';
import type { ResearchEnvironmentProbeResource } from '../../../shared/schemas/research-process-resources';
import { captureNativeCode } from './experiment-native-code';
import type { NativeCodeSnapshot } from './experiment-native-code-schema';
import { discoverPythonEnvironmentControls, type PythonEnvironmentControls } from './experiment-python-controls';
import { runEnvironmentProbe } from './experiment-probe-resources';
import { ResearchProcessError, type ResearchProcessRequest, type ResearchProcessResult } from './process-runner';
import { readResearchFile, researchContentHash } from './research-files';
import type { ResearchProcessScope } from './toolchain';

const distribution = z.strictObject({
  name: z.string().max(256).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  version: z.string().min(1).max(256).regex(/^[0-9][A-Za-z0-9.!+_-]*$/u)
});
const distributions = z.array(distribution).max(10000).superRefine((items, context) => {
  if (new Set(items.map(item => item.name)).size !== items.length) {
    context.addIssue({ code: 'custom', message: 'research_python_distribution_duplicate' });
  }
});
export const pythonEnvironmentLockSchema = z.strictObject({
  schemaVersion: z.literal(1),
  python: z.strictObject({
    implementation: z.literal('cpython'), version: z.string().regex(/^3\.14\.\d+$/u),
    platform: z.literal('darwin'), architecture: z.literal('arm64')
  }),
  distributions
});
const path = z.string().min(1).max(4096);
const reportSchema = z.strictObject({
  implementation: z.literal('cpython'), version: z.string().regex(/^3\.14\.\d+$/u),
  platform: z.literal('darwin'), architecture: z.literal('arm64'),
  executable: path, prefix: path, basePrefix: path, modulePaths: z.array(path).length(3),
  flags: z.strictObject({
    isolated: z.literal(1), ignoreEnvironment: z.literal(1), noSite: z.literal(1),
    noUserSite: z.literal(1), safePath: z.literal(true), dontWriteBytecode: z.literal(1), utf8Mode: z.literal(1)
  }),
  siteLoaded: z.literal(false), distributions
});

export const pythonExperimentFlags = ['-I', '-S', '-B', '-X', 'utf8'] as const;
/** Inspect explicit installed metadata without adding site-packages to sys.path or importing entry points. */
export const pythonEnvironmentProbe = String.raw`import sys, os, json, re
from importlib.metadata import distributions
package_path = sys.argv[1]
for name in os.listdir(package_path):
    if name.lower().endswith((".pth", ".egg-link", ".egg", ".egg-info")):
        raise RuntimeError("research_python_package_layout_unsupported")
packages = []
for item in distributions(path=[package_path]):
    if len(packages) >= 10000:
        raise RuntimeError("research_python_distribution_limit")
    if item.read_text("direct_url.json") is not None:
        raise RuntimeError("research_python_direct_dependency_unsupported")
    names = item.metadata.get_all("Name", [])
    versions = item.metadata.get_all("Version", [])
    if len(names) != 1 or len(versions) != 1:
        raise RuntimeError("research_python_distribution_metadata_invalid")
    packages.append({"name": re.sub(r"[-_.]+", "-", names[0]).lower(), "version": versions[0]})
print(json.dumps({
    "implementation": sys.implementation.name, "version": sys.version.split()[0],
    "platform": sys.platform, "architecture": os.uname().machine,
    "executable": sys.executable, "prefix": sys.prefix, "basePrefix": sys.base_prefix,
    "modulePaths": sys.path, "siteLoaded": "site" in sys.modules,
    "flags": {"isolated": sys.flags.isolated, "ignoreEnvironment": sys.flags.ignore_environment,
        "noSite": sys.flags.no_site, "noUserSite": sys.flags.no_user_site, "safePath": sys.flags.safe_path,
        "dontWriteBytecode": sys.flags.dont_write_bytecode, "utf8Mode": sys.flags.utf8_mode},
    "distributions": sorted(packages, key=lambda item: item["name"])
}, sort_keys=True))
`;

type PythonEnvironmentInspectionInput = {
  workspace: string;
  selectedExecutable: string;
  jobDir: string;
  run: (request: ResearchProcessRequest) => Promise<ResearchProcessResult>;
  signal: AbortSignal;
  admission: ResearchProcessScope;
  onProbe: (receipt: ResearchEnvironmentProbeResource) => void;
};
export type InspectedPythonEnvironment = {
  controls: PythonEnvironmentControls;
  lockFile: ResearchExperimentEnvironment['lockFiles'][number];
  report: z.infer<typeof reportSchema>;
  code: NativeCodeSnapshot;
  metadataHash: string;
};

/** Environment inspection does not grant permission to select or execute this runtime. */
export async function inspectPythonExperimentEnvironment({
  workspace, selectedExecutable, jobDir, run, signal, admission, onProbe
}: PythonEnvironmentInspectionInput): Promise<InspectedPythonEnvironment> {
  const controls = await discoverPythonEnvironmentControls(selectedExecutable, signal);
  const lockBytes = await readResearchFile(workspace, 'roc-python.lock.json', 4 * 1024 ** 2);
  const lock = pythonEnvironmentLockSchema.parse(JSON.parse(lockBytes.toString('utf8')));
  const lockFile = { path: 'roc-python.lock.json', size: lockBytes.length, sha256: researchContentHash(lockBytes) };
  const code = await captureNativeCode(controls.codeRoots, signal);
  const probe = await mkdtemp(join(jobDir, 'python-probe-'));
  try {
    const request: ResearchProcessRequest = {
      command: controls.selectedExecutable, args: [...pythonExperimentFlags, '-c', pythonEnvironmentProbe, controls.packagePath],
      cwd: probe, readablePaths: [...controls.codeRoots, ...controls.controls.map(file => file.path)],
      writablePaths: [probe], environment: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', TMPDIR: probe },
      writeLimits: [{ path: probe, maxFileBytes: 4 * 1024 ** 2, maxTotalBytes: 16 * 1024 ** 2, maxFiles: 100, maxEntries: 200 }],
      timeoutMs: 60000, maxOutputBytes: 4 * 1024 ** 2,
      resourceLimits: { mode: 'monitored', cpuTimeMs: 30_000, maxResidentBytes: 512 * 1024 ** 2 },
      admission: { ...admission, resourceClass: 'utility' }, signal, allowGpuAcceleration: false, networkAccess: 'none'
    };
    const result = await runEnvironmentProbe('environment', request, run, onProbe);
    const fail = (code: string): never => {
      const error = new ResearchProcessError(code, result.stdout, result.stderr, result.resourceUsage);
      error.admission = result.admission;
      throw error;
    };
    if (result.exitCode !== 0) fail('research_python_environment_probe_failed');
    let report: z.infer<typeof reportSchema>;
    try { report = reportSchema.parse(JSON.parse(result.stdout)); }
    catch { return fail('research_python_environment_report_invalid'); }
    if (report.executable !== controls.selectedExecutable || report.prefix !== controls.prefix || report.basePrefix !== controls.basePrefix
      || JSON.stringify(report.modulePaths) !== JSON.stringify(controls.modulePaths)) fail('research_python_startup_paths_changed');
    if (report.version !== lock.python.version) fail('research_python_runtime_version_mismatch');
    const expected = [...lock.distributions].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    if (JSON.stringify(report.distributions) !== JSON.stringify(expected)) fail('research_python_installed_distributions_mismatch');
    if (JSON.stringify(await discoverPythonEnvironmentControls(selectedExecutable, signal)) !== JSON.stringify(controls)) {
      fail('research_python_environment_controls_changed');
    }
    if (researchContentHash(await readResearchFile(workspace, lockFile.path, 4 * 1024 ** 2)) !== lockFile.sha256) {
      fail('research_python_lock_changed');
    }
    if ((await captureNativeCode(controls.codeRoots, signal)).hash !== code.hash) fail('research_python_native_code_changed');
    signal.throwIfAborted();
    const metadataHash = researchContentHash(JSON.stringify({
      inspectionContractVersion: 1, controls, lockFile, code: code.hash, report, probe: researchContentHash(pythonEnvironmentProbe)
    }));
    return { controls, lockFile, report, code, metadataHash };
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}
