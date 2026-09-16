export const inspectPythonEnvironment = `import importlib.metadata, json, platform, sys
distributions = list(importlib.metadata.distributions())
packages = sorted((dict(name=dist.metadata["Name"], version=dist.version) for dist in distributions), key=lambda item: (item["name"].lower(), item["version"]))
metadata_paths = sorted({str(dist._path) for dist in distributions})
print(json.dumps(dict(executable=sys.executable, prefix=sys.prefix, basePrefix=sys.base_prefix, version=platform.python_version(), platform=sys.platform, architecture=platform.machine(), packages=packages, metadataPaths=metadata_paths)))
`;
