import { readResearchFile, researchContentHash } from './research-files';

export const pythonProjectFileNames = ['pyproject.toml', 'uv.lock', '.python-version'] as const;
export type PythonProjectFile = { path: typeof pythonProjectFileNames[number]; size: number; sha256: string };

export async function readPythonProjectFiles(workspace: string): Promise<{ files: PythonProjectFile[]; version: string }> {
  const files: PythonProjectFile[] = [];
  let version = '';
  for (const path of pythonProjectFileNames) {
    const bytes = await readResearchFile(workspace, path, path === '.python-version' ? 128 : 4 * 1024 ** 2);
    if (bytes.length === 0) throw new Error('research_python_project_file_empty');
    if (path === '.python-version') {
      version = bytes.toString('utf8').trim();
      if (!/^3\.14\.(?:0|[1-9][0-9]*)$/u.test(version)) throw new Error('research_python_project_pin_invalid');
    }
    files.push({ path, size: bytes.length, sha256: researchContentHash(bytes) });
  }
  return { files, version };
}

/** Data-only TOML validation shared by preparation and isolated runtime inspection. */
export const pythonProjectValidation = String.raw`
import re, tomllib
from urllib.parse import urlsplit
def project_declarations(project_path, lock_path=None):
    with open(project_path, "rb") as file:
        data = tomllib.load(file)
    project = data.get("project")
    if not isinstance(project, dict) or not isinstance(project.get("name"), str):
        raise RuntimeError("research_python_project_metadata_required")
    if project.get("dynamic") or data.get("dependency-groups") or data.get("tool", {}).get("uv"):
        raise RuntimeError("research_python_project_configuration_unsupported")
    requirements = project.get("dependencies", [])
    optional = project.get("optional-dependencies", {})
    if not isinstance(requirements, list) or not isinstance(optional, dict):
        raise RuntimeError("research_python_dependency_invalid")
    requirements = list(requirements)
    for group in optional.values():
        if not isinstance(group, list):
            raise RuntimeError("research_python_dependency_invalid")
        requirements.extend(group)
    for requirement in requirements:
        if (not isinstance(requirement, str) or len(requirement) > 4096
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*(?:\[[A-Za-z0-9_, .-]+\])?[A-Za-z0-9_.*!<>=~;,() '+\"-]*", requirement)
                or any(char in requirement for char in "@/:\\\n\r")):
            raise RuntimeError("research_python_direct_dependency_unsupported")
    constraint = project.get("requires-python")
    if not isinstance(constraint, str) or not re.fullmatch(r"[0-9.*!<>=~, ]+", constraint):
        raise RuntimeError("research_python_project_requires_python_invalid")
    if lock_path is None:
        return {}
    with open(lock_path, "rb") as file:
        lock = tomllib.load(file)
    if lock.get("version") != 1 or not isinstance(lock.get("package"), list):
        raise RuntimeError("research_python_lock_invalid")
    packages = {}
    virtual = 0
    normalize = lambda name: re.sub(r"[-_.]+", "-", name).lower()
    for package in lock["package"]:
        name, version, source = package.get("name"), package.get("version"), package.get("source")
        if not isinstance(name, str) or not isinstance(version, str):
            raise RuntimeError("research_python_lock_invalid")
        if source == {"virtual": "."} and name == normalize(project["name"]):
            virtual += 1
            continue
        if source != {"registry": "https://pypi.org/simple"}:
            raise RuntimeError("research_python_lock_source_unsupported")
        wheels = package.get("wheels", [])
        if not wheels:
            raise RuntimeError("research_python_wheel_required")
        for asset in [*wheels, *([package["sdist"]] if "sdist" in package else [])]:
            url = urlsplit(asset.get("url", ""))
            if (url.scheme != "https" or url.netloc != "files.pythonhosted.org"
                    or not url.path.startswith("/packages/") or url.query or url.fragment
                    or not re.fullmatch(r"sha256:[0-9a-f]{64}", asset.get("hash", ""))):
                raise RuntimeError("research_python_lock_asset_invalid")
        packages.setdefault(normalize(name), []).append(version)
    if virtual != 1:
        raise RuntimeError("research_python_lock_project_invalid")
    return packages
`;
