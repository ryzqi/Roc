export const rEnvironmentProbe = `project <- Sys.getenv("ROC_PROJECT_ROOT")
library <- normalizePath(Sys.getenv("ROC_R_LIBRARY"), mustWork = TRUE)
.libPaths(c(library, .Library), include.site = FALSE)
if (!requireNamespace("renv", quietly = TRUE)) stop("research_experiment_renv_required")
lockfile <- file.path(project, "renv.lock")
lock <- renv::lockfile_read(lockfile)
if (!is.character(lock$R$Version) || length(lock$R$Version) != 1) stop("research_experiment_lock_invalid")
if (!identical(lock$R$Version, as.character(getRversion()))) stop("research_experiment_runtime_version_mismatch")
status <- renv::status(project = project, library = library, lockfile = lockfile, sources = FALSE, cache = FALSE)
if (!isTRUE(status$synchronized)) stop("research_experiment_environment_outdated")
packages <- installed.packages(lib.loc = c(library, .Library), noCache = TRUE)
report <- data.frame(type = rep("runtime", 5), name = c("version", "platform", "architecture", "prefix", "basePrefix"),
  value = c(as.character(getRversion()), R.version$os, R.version$arch, library, normalizePath(R.home(), mustWork = TRUE)))
for (index in seq_len(nrow(packages))) {
  report <- rbind(report, data.frame(type = "package", name = packages[index, "Package"], value = packages[index, "Version"]))
  report <- rbind(report, data.frame(type = "metadata", name = normalizePath(file.path(packages[index, "LibPath"], packages[index, "Package"], "DESCRIPTION"), mustWork = TRUE), value = ""))
}
write.csv(report, Sys.getenv("ROC_ENVIRONMENT_REPORT"), row.names = FALSE, fileEncoding = "UTF-8")
`;

export const juliaEnvironmentProbe = String.raw`using Pkg, TOML, SHA
Pkg.offline(true)
json_string(value::AbstractString) = string('"', replace(replace(replace(replace(value, "\\" => "\\\\"), "\"" => "\\\""), '\n' => "\\n"), '\r' => "\\r"), '"')
json_value(value::AbstractString) = json_string(value)
json_value(value::AbstractVector) = string("[", join(map(json_value, value), ","), "]")
json_value(value::AbstractDict) = string("{", join((string(json_string(string(key)), ":", json_value(item)) for (key, item) in value), ","), "}")
function project_files(environment)
    paths = Set([environment.project_file, environment.manifest_file, collect(keys(environment.workspace))...])
    for path in collect(paths), name in (Base.preferences_names..., Pkg.Artifacts.artifact_names...)
        candidate = joinpath(dirname(path), name)
        isfile(candidate) && push!(paths, candidate)
    end
    sort!(collect(paths))
end
function file_hash(path)
    filesize(path) <= 16 * 1024 * 1024 || error("research_experiment_metadata_limit")
    bytes2hex(open(sha256, path))
end
environment = Pkg.Types.EnvCache()
files = project_files(environment)
before = Dict(path => file_hash(path) for path in files)
environment = Pkg.Types.EnvCache()
project_files(environment) == files || error("research_experiment_environment_changed")
isfile(environment.project_file) && isfile(environment.manifest_file) || error("research_experiment_lock_required")
manifest = TOML.parsefile(environment.manifest_file)
haskey(manifest, "julia_version") || error("research_experiment_lock_invalid")
VersionNumber(manifest["julia_version"]) == VERSION || error("research_experiment_runtime_version_mismatch")
Pkg.Operations.is_manifest_current(environment) === true || error("research_experiment_environment_outdated")
Pkg.Operations.is_instantiated(environment) || error("research_experiment_packages_missing")
environment.project.manifest === nothing || !isabspath(environment.project.manifest) || error("research_experiment_absolute_dependency_path")
packages = []
metadata = String[]
for (uuid, information) in Pkg.dependencies(environment)
    entry = environment.manifest[uuid]
    entry.path === nothing || !isabspath(entry.path) || error("research_experiment_absolute_dependency_path")
    project = joinpath(information.source, "Project.toml")
    isfile(project) || error("research_experiment_package_metadata_missing")
    data = TOML.parsefile(project)
    version = get(data, "version", nothing)
    if version !== nothing && information.version !== nothing
        VersionNumber(version) == information.version || error("research_experiment_environment_outdated")
    end
    push!(packages, Dict("name" => information.name, "versions" => version === nothing ? String[] : [string(version)]))
    push!(metadata, project)
end
after = Dict(path => file_hash(path) for path in files)
before == after || error("research_experiment_environment_changed")
report = Dict("version" => string(VERSION), "platform" => string(Sys.KERNEL), "architecture" => string(Sys.ARCH),
    "prefix" => realpath(ENV["ROC_JULIA_DEPOT"]), "basePrefix" => realpath(joinpath(Sys.BINDIR, "..")),
    "packages" => packages, "metadataPaths" => sort!(unique(metadata)),
    "controls" => [Dict("path" => path, "sha256" => before[path]) for path in files])
write(ENV["ROC_ENVIRONMENT_REPORT"], json_value(report))
`;

function parseCsvRow(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') {
        field += '"';
        index += 1;
        continue;
      }
      if (character === '"') {
        quoted = false;
        continue;
      }
      field += character;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === ',') {
      fields.push(field);
      field = '';
      continue;
    }
    field += character;
  }
  if (quoted) throw new Error('research_experiment_environment_report_invalid');
  fields.push(field);
  return fields;
}

function parseRenvCsv(text: string): Record<string, unknown> {
  const lines = text.replace(/^\uFEFF/u, '').split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length === 0) throw new Error('research_experiment_environment_report_invalid');
  const header = parseCsvRow(lines[0]);
  const typeIndex = header.indexOf('type');
  const nameIndex = header.indexOf('name');
  const valueIndex = header.indexOf('value');
  if (typeIndex < 0 || nameIndex < 0 || valueIndex < 0) throw new Error('research_experiment_environment_report_invalid');
  const runtime: Record<string, string> = {};
  const packages: Array<{ name: string; versions: string[] }> = [];
  const metadataPaths: string[] = [];
  for (const line of lines.slice(1)) {
    const row = parseCsvRow(line);
    const type = row[typeIndex] ?? '';
    const name = row[nameIndex] ?? '';
    const value = row[valueIndex] ?? '';
    if (type === 'runtime') runtime[name] = value;
    else if (type === 'package') packages.push({ name, versions: [value] });
    else if (type === 'metadata') metadataPaths.push(name);
  }
  return { ...runtime, packages, metadataPaths, controls: [] };
}

export function normalizeNativeEnvironmentReport(kind: 'renv' | 'julia', text: string): unknown {
  if (kind === 'julia') {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error('research_experiment_environment_report_invalid');
    }
  }
  if (kind !== 'renv') throw new Error('research_experiment_runtime_invalid');
  return parseRenvCsv(text);
}

export const juliaExperimentFlags = ['--startup-file=no', '--history-file=no', '--compiled-modules=existing', '--pkgimages=existing'] as const;

export function rExperimentCommand(root: string, executable: string, args: readonly string[]): { command: string; args: string[] } {
  return { command: '/usr/bin/env', args: [`R_HOME=${root}`, `DYLD_LIBRARY_PATH=${root}/lib`, executable, ...args] };
}
