import type { ResearchNotebookReceipt } from '../../../shared/schemas/research-notebooks';
import { researchNotebookReceiptSchema } from '../../../shared/schemas/research-notebooks';
import { parseResearchNotebook } from './notebook-parser';
import { researchContentHash } from './research-files';

/**
 * Subset 1: all Python code cells in original order, a shared __main__ namespace,
 * exec-mode statements, explicit outputs through roc_experiment. No interactive
 * display, future-state propagation, magics, shell cells or Notebook extensions.
 * The selected PR08 interpreter compiles every cell before any cell executes.
 */
const executor = String.raw`import ast as _nb_ast, base64 as _nb_base64, json as _nb_json, sys as _nb_sys, types as _nb_types
_nb_payload = _nb_json.loads(_nb_base64.b64decode(_nb_encoded).decode("utf-8"))
_nb_imports = frozenset((
    "roc_experiment", "math", "statistics", "csv", "json", "pathlib", "random",
    "hashlib", "datetime", "decimal", "fractions", "itertools", "functools",
    "collections", "typing", "numpy", "scipy", "pandas", "matplotlib"
))
_nb_dynamic = frozenset(("get_ipython", "__import__", "eval", "exec", "compile", "globals", "locals"))
_nb_program = []
for _nb_cell in _nb_payload["cells"]:
    _nb_filename = "roc-notebook:" + _nb_payload["sha256"] + "/" + _nb_cell["id"]
    _nb_tree = compile(_nb_cell["source"], _nb_filename, "exec",
        flags=_nb_ast.PyCF_ONLY_AST, dont_inherit=True, optimize=0)
    for _nb_node in _nb_ast.walk(_nb_tree):
        if isinstance(_nb_node, _nb_ast.Import):
            for _nb_alias in _nb_node.names:
                if _nb_alias.name.split(".")[0] not in _nb_imports:
                    raise SyntaxError("research_notebook_import_unsupported",
                        (_nb_filename, _nb_node.lineno, _nb_node.col_offset + 1, None))
        if isinstance(_nb_node, _nb_ast.ImportFrom):
            if _nb_node.level != 0 or _nb_node.module is None or _nb_node.module.split(".")[0] not in _nb_imports:
                raise SyntaxError("research_notebook_import_unsupported",
                    (_nb_filename, _nb_node.lineno, _nb_node.col_offset + 1, None))
        if isinstance(_nb_node, _nb_ast.Name) and _nb_node.id in _nb_dynamic:
            raise SyntaxError("research_notebook_dynamic_execution_unsupported",
                (_nb_filename, _nb_node.lineno, _nb_node.col_offset + 1, None))
        if isinstance(_nb_node, _nb_ast.Attribute) and _nb_node.attr.startswith("__"):
            raise SyntaxError("research_notebook_reflection_unsupported",
                (_nb_filename, _nb_node.lineno, _nb_node.col_offset + 1, None))
    _nb_program.append((_nb_filename, compile(_nb_tree, _nb_filename, "exec", dont_inherit=True, optimize=0)))
_nb_module = _nb_types.ModuleType("__main__")
_nb_sys.modules["__main__"] = _nb_module
for _nb_filename, _nb_code in _nb_program:
    _nb_module.__dict__["__file__"] = _nb_filename
    exec(_nb_code, _nb_module.__dict__)
`;

export type NotebookPythonSource = {
  subsetVersion: 1;
  notebookId: string;
  receiptHash: string;
  sha256: string;
  cells: { id: string; index: number; cellHash: string; sourceHash: string; source: string }[];
  executorHash: string;
  source: string;
  sourceHash: string;
};

export function notebookPythonSource(bytes: Uint8Array, input: ResearchNotebookReceipt): NotebookPythonSource {
  const receipt = researchNotebookReceiptSchema.parse(input);
  const { notebook, preview } = parseResearchNotebook(bytes);
  if (preview.sha256 !== receipt.snapshot.sha256 || preview.size !== receipt.snapshot.size ||
    receipt.snapshot.sha256 !== receipt.snapshot.request.expectedSha256 ||
    researchContentHash(JSON.stringify(receipt.snapshot)) !== receipt.snapshotHash) {
    throw new Error('research_notebook_hash_mismatch');
  }
  if (notebook.metadata.language_info?.name !== 'python' ||
    (notebook.metadata.kernelspec !== undefined &&
      (notebook.metadata.kernelspec.name !== 'python3' || notebook.metadata.kernelspec.language !== 'python'))) {
    throw new Error('research_notebook_python_language_required');
  }
  if (notebook.cells.some(cell => cell.cell_type === 'raw')) throw new Error('research_notebook_raw_cell_unsupported');
  const cells = notebook.cells.flatMap((cell, index) => {
    if (cell.cell_type !== 'code') return [];
    const original = preview.cells[index]!;
    return [{ id: cell.id, index, cellHash: original.cellHash, sourceHash: original.sourceHash,
      source: typeof cell.source === 'string' ? cell.source : cell.source.join('') }];
  });
  if (cells.length === 0) throw new Error('research_notebook_code_cells_required');
  const payload = {
    subsetVersion: 1 as const, notebookId: receipt.snapshot.id, receiptHash: receipt.snapshotHash,
    sha256: preview.sha256, cells, executorHash: researchContentHash(executor)
  };
  // ASCII base64 keeps Python quoting separate from untrusted cell text.
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const source = `_nb_encoded = "${encoded}"\n${executor}`;
  return { ...payload, source, sourceHash: researchContentHash(source) };
}
