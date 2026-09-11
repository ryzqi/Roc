"""在空缓存、受控网络和搬迁路径下验证真实科研工具链。"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess

from manifest import verify_manifest


OFFLINE_PROFILE = "(version 1)(allow default)(deny network*)"
NOTEBOOK_PROFILE = ('(version 1)(allow default)(deny network*)'
                    '(allow network-outbound (remote ip "localhost:*"))'
                    '(allow network-inbound (local ip "localhost:*"))')

LATEX = r"""\documentclass[fontset=fandol]{ctexart}
\usepackage{amsmath,booktabs,graphicx}
\begin{document}
\section{研究数据与方法 Research methods}
This experiment compares control and treatment groups.
\begin{table}[h]
\centering
\caption{Study participants and results}
\begin{tabular}{lrr}
\toprule
Group & Patients & Improvement \\
\midrule
Control & 12 & 10 \\
Treatment & 18 & 50 \\
\bottomrule
\end{tabular}
\end{table}
The energy equation is:
\begin{equation}E = mc^2\end{equation}
\begin{figure}[h]
\centering
\includegraphics[width=0.65\textwidth]{figure.png}
\caption{Measured improvement by study group.}
\end{figure}
\end{document}
"""

PLOT = """import matplotlib
matplotlib.use('Agg')
from matplotlib import pyplot as plt
fig, ax = plt.subplots(figsize=(5, 2.5), layout='constrained')
ax.bar(['Control', 'Treatment'], [10, 50], color=['#66788a', '#20736b'])
ax.set_ylabel('Improvement (percent)')
for extension in ['png', 'svg', 'pdf']:
    fig.savefig(f'figure.{extension}', dpi=180)
plt.close(fig)
"""

NOTEBOOK = """import json
from pathlib import Path
import nbformat
from nbclient import NotebookClient
notebook = nbformat.v4.new_notebook(cells=[nbformat.v4.new_code_cell('print(sum([12, 18]))')])
NotebookClient(notebook, timeout=45, kernel_name='python3').execute()
nbformat.write(notebook, 'executed.ipynb')
assert notebook.cells[0].outputs[0].text.strip() == '30'
print(json.dumps({'notebookResult': 30}))
"""


def smoke(toolchain: Path, output: Path) -> None:
    toolchain = toolchain.resolve(strict=True)
    manifest = verify_manifest(toolchain)
    if output.exists() or output.is_symlink():
        raise ValueError("research_smoke_output_exists")
    output.mkdir(parents=True)
    output = output.resolve()
    cache = output / "cache"
    cache.mkdir()
    temporary = cache / "tmp"
    temporary.mkdir()
    python = toolchain / "python/bin/python3"
    environment = {key: os.environ[key] for key in ("HOME", "USER", "LOGNAME", "LANG") if key in os.environ}
    environment.update({"PATH": f"{toolchain}/python/bin:{toolchain}/bin:/usr/bin:/bin:/usr/sbin:/sbin",
                        "TMPDIR": str(temporary), "XDG_CACHE_HOME": str(cache), "MPLCONFIGDIR": str(cache / "matplotlib"),
                        "TECTONIC_CACHE_DIR": str(cache / "tectonic"), "HF_HOME": str(cache / "huggingface"),
                        "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_HUB_DISABLE_IMPLICIT_TOKEN": "1",
                        "HF_HUB_DISABLE_TELEMETRY": "1", "PYTHONDONTWRITEBYTECODE": "1", "PYTHONNOUSERSITE": "1",
                        "JUPYTER_CONFIG_DIR": str(cache / "jupyter-config"), "JUPYTER_DATA_DIR": str(cache / "jupyter-data"),
                        "JUPYTER_RUNTIME_DIR": str(cache / "jupyter-runtime"),
                        "JUPYTER_PATH": str(toolchain / "python/share/jupyter")})

    def run(label: str, command: list, *, request: dict | None = None, notebook: bool = False, timeout: int = 300) -> str:
        profile = NOTEBOOK_PROFILE if notebook else OFFLINE_PROFILE
        result = subprocess.run(["/usr/bin/sandbox-exec", "-p", profile, *command], cwd=output, env=environment,
                                input=json.dumps(request) if request is not None else None,
                                capture_output=True, text=True, timeout=timeout)
        (output / f"{label}.stdout.log").write_text(result.stdout, encoding="utf-8")
        (output / f"{label}.stderr.log").write_text(result.stderr, encoding="utf-8")
        if result.returncode != 0:
            raise RuntimeError(f"research_smoke_failed:{label}:exit={result.returncode}; logs={output}")
        print(f"通过：{label}", flush=True)
        return result.stdout

    run("network-denied", [python, "-I", "-B", "-c",
                           "import socket\ns=socket.socket()\ntry:\n s.connect(('1.1.1.1',443))\nexcept PermissionError:\n print('network denied')\nelse:\n raise RuntimeError('network was not denied')\nfinally:\n s.close()"])
    (output / "plot.py").write_text(PLOT, encoding="utf-8")
    run("matplotlib", [python, "-I", "-B", output / "plot.py"])
    for extension, signature in [("png", b"\x89PNG"), ("pdf", b"%PDF"), ("svg", b"<?xml")]:
        if not (output / f"figure.{extension}").read_bytes().startswith(signature):
            raise RuntimeError(f"research_smoke_figure_invalid:{extension}")
    (output / "paper.tex").write_text(LATEX, encoding="utf-8")
    compiled = output / "compiled"
    compiled.mkdir()
    run("latex", [toolchain / "bin/tectonic", "--bundle", toolchain / "tex/bundle.zip", "--only-cached",
                  "--untrusted", "--keep-logs", "--outdir", compiled, "paper.tex"], timeout=180)
    pdf = compiled / "paper.pdf"
    if not pdf.read_bytes().startswith(b"%PDF"):
        raise RuntimeError("research_smoke_pdf_invalid")
    rendered = json.loads(run("render", [python, "-I", "-B", toolchain / "worker.py"], request={
        "operation": "render_pdf", "projectRoot": str(output), "sourcePath": str(pdf),
        "outputDir": str(output / "rendered"), "page": 1, "scale": 2}))
    if not rendered["ok"] or "研究数据与方法" not in rendered["result"]["text"]:
        raise RuntimeError("research_smoke_pdf_text_missing")
    parsed = json.loads(run("ocr-table-formula", [python, "-I", "-B", toolchain / "worker.py"], request={
        "operation": "parse_document", "projectRoot": str(output), "sourcePath": rendered["result"]["path"],
        "outputDir": str(output / "parsed"), "modelsPath": str(toolchain / "models")}))
    if not parsed["ok"]:
        raise RuntimeError("research_smoke_parse_failed")
    content = parsed["result"]["content"]
    kinds = {block["kind"] for block in parsed["result"]["blocks"]}
    if ("研究数据与方法" not in content or "Treatment" not in content or "18" not in content
            or not {"table", "formula", "figure"}.issubset(kinds)):
        raise RuntimeError(f"research_smoke_parse_content_incomplete:{sorted(kinds)}")
    (output / "parse-result.json").write_text(json.dumps(parsed["result"], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    native = json.loads(run("native-pdf", [python, "-I", "-B", toolchain / "worker.py"], request={
        "operation": "parse_document", "projectRoot": str(output), "sourcePath": str(pdf),
        "outputDir": str(output / "parsed-pdf"), "modelsPath": str(toolchain / "models")}))
    if not native["ok"] or "Treatment" not in native["result"]["content"] or native["result"]["pageCount"] != 1:
        raise RuntimeError("research_smoke_native_pdf_incomplete")
    html = output / "paper.html"
    html.write_text('<html><body><h1>研究方法</h1><p>Local HTML evidence.</p>'
                    '<table><tr><th>Group</th><th>Patients</th></tr><tr><td>Treatment</td><td>18</td></tr></table>'
                    '</body></html>', encoding="utf-8")
    parsed_html = json.loads(run("html", [python, "-I", "-B", toolchain / "worker.py"], request={
        "operation": "parse_document", "projectRoot": str(output), "sourcePath": str(html),
        "outputDir": str(output / "parsed-html"), "modelsPath": str(toolchain / "models")}))
    if not parsed_html["ok"] or "研究方法" not in parsed_html["result"]["content"] or "18" not in parsed_html["result"]["content"]:
        raise RuntimeError("research_smoke_html_incomplete")
    run("notebook", [python, "-I", "-B", "-c", NOTEBOOK], notebook=True, timeout=90)
    run("relocated-console-script", [toolchain / "python/bin/ipython", "--version"], timeout=30)
    verify_manifest(toolchain)
    result = {"architecture": manifest["architecture"], "versions": manifest["versions"],
              "network": "denied except notebook loopback", "pageCount": rendered["result"]["pageCount"],
              "blockKinds": sorted(kinds), "blockCount": len(parsed["result"]["blocks"]),
              "warnings": parsed["result"]["warnings"], "notebookResult": 30,
              "nativePdfBlocks": len(native["result"]["blocks"]), "htmlBlocks": len(parsed_html["result"]["blocks"]),
              "figures": ["png", "svg", "pdf"], "integrity": "passed"}
    (output / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--toolchain", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    smoke(arguments.toolchain, arguments.output)
