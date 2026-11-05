import { lstat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parse } from 'smol-toml';
import { z } from 'zod';
import type { ResearchExperimentEnvironment } from '../../../shared/schemas/research-experiments';
import { readResearchFile, researchContentHash, researchRelativePath } from './research-files';

type ControlFile = ResearchExperimentEnvironment['lockFiles'][number];
export type JuliaEnvironmentControls = { lockFiles: ControlFile[]; metadataFiles: ControlFile[] };
const projectNames = ['JuliaProject.toml', 'Project.toml'];
const siblingNames = ['JuliaLocalPreferences.toml', 'LocalPreferences.toml', 'JuliaArtifacts.toml', 'Artifacts.toml'];
const pathDeclaration = z.string().min(1);
const projectSchema = z.object({
  manifest: pathDeclaration.optional(),
  workspace: z.object({ projects: z.array(pathDeclaration).max(1000).optional() }).passthrough().optional(),
  sources: z.record(z.string(), z.object({ path: pathDeclaration.optional() }).passthrough()).optional()
}).passthrough();
const manifestSchema = z.object({
  julia_version: z.string().min(1),
  deps: z.record(z.string(), z.array(z.object({ path: pathDeclaration.optional() }).passthrough())).optional()
}).passthrough();

export function parseJuliaRuntimeVersion(stdout: string): string {
  const match = /^julia version (\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?)\s*$/u.exec(stdout);
  if (match === null) throw new Error('research_experiment_runtime_version_invalid');
  return match[1];
}

/** Discover only declared controls and local package metadata; no project-directory read grant. */
export async function discoverJuliaEnvironmentControls(workspace: string, version: string, signal: AbortSignal): Promise<JuliaEnvironmentControls> {
  const controls = new Map<string, ControlFile>();
  const metadata = new Map<string, ControlFile>();
  const projects = new Map<string, z.infer<typeof projectSchema>>();
  const localDirectories = new Set<string>();
  let totalBytes = 0;
  const freeze = async (path: string, target: Map<string, ControlFile>): Promise<Buffer> => {
    signal.throwIfAborted();
    const bytes = await readResearchFile(workspace, path, 16 * 1024 * 1024);
    if (!target.has(path)) {
      totalBytes += bytes.length;
      if (totalBytes > 64 * 1024 * 1024 || controls.size + metadata.size >= 10000 || target === controls && controls.size >= 1000) {
        throw new Error('research_experiment_metadata_limit');
      }
      target.set(path, { path, sha256: researchContentHash(bytes), size: bytes.length });
    }
    return bytes;
  };
  const selectProject = async (directory: string): Promise<string> => {
    const selected = await selectFile(workspace, directory, projectNames);
    if (selected === null) throw new Error('research_experiment_project_required');
    return selected;
  };
  const visiting = new Set<string>();
  const pending = [{ path: await selectProject(workspace), exit: false }];
  while (pending.length > 0) {
    const { path, exit } = pending.pop()!;
    if (exit) { visiting.delete(path); continue; }
    if (visiting.has(path)) throw new Error('research_experiment_workspace_cycle');
    if (projects.has(path)) continue;
    visiting.add(path);
    pending.push({ path, exit: true });
    const data = projectSchema.parse(parse((await freeze(path, controls)).toString('utf8')));
    projects.set(path, data);
    const directory = dirname(join(workspace, path));
    for (const child of data.workspace?.projects ?? []) {
      const childDirectory = declaredPath(workspace, directory, child);
      pending.push({ path: await selectProject(childDirectory), exit: false });
    }
    for (const source of Object.values(data.sources ?? {})) {
      if (source.path !== undefined) localDirectories.add(declaredPath(workspace, directory, source.path));
    }
  }
  const activeProject = projects.values().next().value!;
  const series = /^\d+\.\d+/u.exec(version);
  if (series === null) throw new Error('research_experiment_runtime_version_invalid');
  const manifest = activeProject.manifest === undefined
    ? await selectFile(workspace, workspace, [`JuliaManifest-v${series[0]}.toml`, `Manifest-v${series[0]}.toml`, 'JuliaManifest.toml', 'Manifest.toml', 'AppManifest.toml'])
    : researchRelativePath(relative(workspace, declaredPath(workspace, workspace, activeProject.manifest)));
  if (manifest === null) throw new Error('research_experiment_lock_required');
  const manifestData = manifestSchema.parse(parse((await freeze(manifest, controls)).toString('utf8')));
  if (manifestData.julia_version !== version) throw new Error('research_experiment_runtime_version_mismatch');
  for (const entries of Object.values(manifestData.deps ?? {})) {
    for (const entry of entries) if (entry.path !== undefined) localDirectories.add(declaredPath(workspace, dirname(join(workspace, manifest)), entry.path));
  }
  const siblingDirectories = new Set([...controls.keys()].map(path => dirname(join(workspace, path))));
  for (const directory of siblingDirectories) {
    for (const name of siblingNames) {
      const path = researchRelativePath(relative(workspace, join(directory, name)));
      if (await fileExists(join(workspace, path))) {
        parse((await freeze(path, controls)).toString('utf8'));
      }
    }
  }
  for (const directory of localDirectories) {
    const path = await selectProject(directory);
    const bytes = await freeze(path, metadata);
    z.object({ name: z.string().min(1) }).passthrough().parse(parse(bytes.toString('utf8')));
  }
  // Pkg.dependencies can report a workspace member itself as a local dependency.
  for (const [path, file] of controls) if (projects.has(path)) metadata.set(path, file);
  return {
    lockFiles: [...controls.values()].sort((left, right) => left.path.localeCompare(right.path)),
    metadataFiles: [...metadata.values()].sort((left, right) => left.path.localeCompare(right.path))
  };
}

function declaredPath(workspace: string, directory: string, value: string): string {
  if (isAbsolute(value) || /[\\\u0000-\u001f]/u.test(value)) throw new Error('research_experiment_absolute_dependency_path');
  const path = resolve(directory, value);
  if (path !== workspace) researchRelativePath(relative(workspace, path));
  return path;
}
async function selectFile(workspace: string, directory: string, names: readonly string[]): Promise<string | null> {
  for (const name of names) {
    const path = researchRelativePath(relative(workspace, join(directory, name)));
    if (await fileExists(join(workspace, path))) return path;
  }
  return null;
}
async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error('research_path_symlink');
    return info.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
