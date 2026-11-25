import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { z } from 'zod';
import type { ResearchExperimentEnvironment } from '../../../shared/schemas/research-experiments';
import type { ResearchEnvironmentProbeResource } from '../../../shared/schemas/research-process-resources';
import { captureNativeCode } from './experiment-native-code';
import type { NativeCodeSnapshot } from './experiment-native-code-schema';
import { discoverPythonEnvironmentControls } from './experiment-python-controls';
import {
  assertPythonCodeReceipt, pythonEnvironmentReportSchema,
  type PythonCodeReceipt, type PythonEnvironmentControls
} from './experiment-python-code-schema';
import { runEnvironmentProbe } from './experiment-probe-resources';
import { ResearchProcessError, type ResearchProcessRequest, type ResearchProcessResult } from './process-runner';
import { researchContentHash } from './research-files';
import { pythonProjectValidation, readPythonProjectFiles } from './python-project-declarations';
import type { ResearchProcessScope } from './toolchain';

export const pythonExperimentFlags = ['-I', '-S', '-B', '-X', 'utf8'] as const;
/** Inspect explicit installed metadata without adding site-packages to sys.path or importing entry points. */
export const pythonEnvironmentProbe = pythonProjectValidation + String.raw`
import sys, os, json, re
from importlib.metadata import distributions
package_path = sys.argv[1]
locked_packages = project_declarations(sys.argv[2], sys.argv[3])
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
    name = re.sub(r"[-_.]+", "-", names[0]).lower()
    if versions[0] not in locked_packages.get(name, []):
        raise RuntimeError("research_python_installed_distributions_mismatch")
    packages.append({"name": name, "version": versions[0]})
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
  lockFiles: ResearchExperimentEnvironment['lockFiles'];
  report: z.infer<typeof pythonEnvironmentReportSchema>;
  code: NativeCodeSnapshot;
  codeReceipt: PythonCodeReceipt;
  metadataHash: string;
};

/** Environment inspection does not grant permission to select or execute this runtime. */
export async function inspectPythonExperimentEnvironment({
  workspace, selectedExecutable, jobDir, run, signal, admission, onProbe
}: PythonEnvironmentInspectionInput): Promise<InspectedPythonEnvironment> {
  const controls = await discoverPythonEnvironmentControls(selectedExecutable, signal);
  const project = await readPythonProjectFiles(workspace);
  const code = await captureNativeCode(controls.codeRoots, signal);
  const probe = await mkdtemp(join(jobDir, 'python-probe-'));
  let safeToClean = true;
  try {
    const request: ResearchProcessRequest = {
      command: controls.selectedExecutable, args: [...pythonExperimentFlags, '-c', pythonEnvironmentProbe, controls.packagePath, join(workspace, 'pyproject.toml'), join(workspace, 'uv.lock')],
      cwd: probe, readablePaths: [...controls.codeRoots, ...controls.controls.map(file => file.path), ...project.files.map(file => join(workspace, file.path))],
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
    if (result.exitCode !== 0) {
      const knownRefusals = new Set([
        'research_python_project_metadata_required', 'research_python_project_configuration_unsupported',
        'research_python_dependency_invalid', 'research_python_direct_dependency_unsupported',
        'research_python_project_requires_python_invalid', 'research_python_lock_invalid',
        'research_python_lock_source_unsupported', 'research_python_wheel_required',
        'research_python_lock_asset_invalid', 'research_python_lock_project_invalid',
        'research_python_package_layout_unsupported', 'research_python_distribution_limit',
        'research_python_distribution_metadata_invalid', 'research_python_installed_distributions_mismatch'
      ]);
      const refusal = /^RuntimeError: (research_python_[a-z_]+)\s*$/mu.exec(result.stderr)?.[1];
      fail(refusal !== undefined && knownRefusals.has(refusal) ? refusal : 'research_python_environment_probe_failed');
    }
    let report: z.infer<typeof pythonEnvironmentReportSchema>;
    try { report = pythonEnvironmentReportSchema.parse(JSON.parse(result.stdout)); }
    catch { return fail('research_python_environment_report_invalid'); }
    if (report.executable !== controls.selectedExecutable || report.prefix !== controls.prefix || report.basePrefix !== controls.basePrefix
      || JSON.stringify(report.modulePaths) !== JSON.stringify(controls.modulePaths)) fail('research_python_startup_paths_changed');
    if (JSON.stringify(await discoverPythonEnvironmentControls(selectedExecutable, signal)) !== JSON.stringify(controls)) {
      fail('research_python_environment_controls_changed');
    }
    if ((await captureNativeCode(controls.codeRoots, signal)).hash !== code.hash) fail('research_python_native_code_changed');
    signal.throwIfAborted();
    if (report.version !== project.version) fail('research_python_runtime_version_mismatch');
    if (JSON.stringify(await readPythonProjectFiles(workspace)) !== JSON.stringify(project)) fail('research_python_lock_changed');
    const lockFiles = project.files;
    const metadataIdentity: PythonCodeReceipt['metadataIdentity'] = {
      inspectionContractVersion: 2, controls, lockFiles, code: code.hash, report, probe: researchContentHash(pythonEnvironmentProbe)
    };
    const metadataHash = researchContentHash(JSON.stringify(metadataIdentity));
    const codeReceipt = assertPythonCodeReceipt({ code, metadataIdentity }, metadataHash);
    return { controls, lockFiles, report, code, codeReceipt, metadataHash };
  } catch (error) {
    if (error instanceof ResearchProcessError && ['research_process_kill_failed',
      'research_process_supervision_failed', 'research_process_completion_failed'].includes(error.code)) safeToClean = false;
    throw error;
  } finally {
    if (safeToClean) await rm(probe, { recursive: true, force: true });
  }
}
