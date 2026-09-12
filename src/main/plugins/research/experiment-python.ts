export const inspectPythonEnvironment = `import importlib.metadata, json, platform, sys
distributions = list(importlib.metadata.distributions())
packages = sorted((dict(name=dist.metadata["Name"], version=dist.version) for dist in distributions), key=lambda item: (item["name"].lower(), item["version"]))
metadata_paths = sorted({str(dist._path) for dist in distributions})
print(json.dumps(dict(executable=sys.executable, prefix=sys.prefix, basePrefix=sys.base_prefix, version=platform.python_version(), platform=sys.platform, architecture=platform.machine(), packages=packages, metadataPaths=metadata_paths)))
`;

export const executePythonNotebook = `import os, subprocess, sys, uuid
import nbformat
from nbclient import NotebookClient
from jupyter_client import KernelManager
from jupyter_client.kernelspec import KernelSpecManager
from jupyter_client.provisioning.local_provisioner import LocalProvisioner

class ExperimentProvisioner(LocalProvisioner):
    async def launch_kernel(self, cmd, **kwargs):
        environment = dict(kwargs["env"])
        environment["JPY_PARENT_PID"] = str(os.getpid())
        self.process = subprocess.Popen(cmd, cwd=kwargs["cwd"], env=environment, stdin=subprocess.DEVNULL, start_new_session=False)
        self.pid = self.process.pid
        self.pgid = None
        self.cwd = kwargs["cwd"]
        return self.connection_info

source, destination, executable, timeout = sys.argv[1:]
notebook = nbformat.read(source, as_version=4)
language = notebook.metadata.get("language_info", {}).get("name")
if language is not None and language.lower() != "python":
    raise ValueError("research_notebook_language_invalid")
spec = KernelSpecManager().get_kernel_spec("roc-experiment")
if spec.argv != [executable, "-B", "-s", "-m", "ipykernel_launcher", "-f", "{connection_file}"]:
    raise ValueError("research_notebook_kernel_changed")
for cell in notebook.cells:
    if cell.cell_type == "code":
        cell.outputs = []
        cell.execution_count = None
manager = KernelManager(kernel_name="roc-experiment", kernel_id=str(uuid.uuid4()))
manager.provisioner = ExperimentProvisioner(kernel_id=manager.kernel_id, kernel_spec=manager.kernel_spec, parent=manager)
client = NotebookClient(notebook, km=manager, timeout=int(timeout), kernel_name="roc-experiment", allow_errors=False, resources={"metadata": {"path": os.getcwd()}})
try:
    client.execute(cleanup_kc=True)
finally:
    nbformat.write(notebook, destination)
`;
