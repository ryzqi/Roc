r"""Regenerates `p5-paper.pdf` — the parse fixture for the P5 acceptance gates.

Why a committed PDF instead of a generated one: gate 1 asserts that a real
document parse yields a heading, at least one **formula** and at least one
**table**, and the only honest way to assert that is to feed the real pipeline
(`docling`, via `resources/research-runtime/worker.py`) a document that contains
them. A PDF written by hand as bytes cannot guarantee that, and a fixture that
silently degrades to "paragraphs only" would turn the gate into a check that a
parse returns *something*.

Measured with the pinned toolchain (`.runtime/research-toolchain/darwin-arm64`,
docling 2.126.0) and the pinned models: one page, ~2 minutes on CPU, output
blocks **heading → paragraph → paragraph → formula → table → paragraph → heading →
paragraph** with locators `pages 1; #/texts/N` and `pages 1; #/tables/0`. The
`formula` block carries LaTeX extracted by CodeFormulaV2 (`\frac`, `\sum`), which
is what `reader-block-formula` renders.

Run (any Python with matplotlib; the toolchain interpreter works):

    .runtime/research-toolchain/darwin-arm64/python/bin/python3 \
        tests/smoke/lib/assets/make-p5-paper.py tests/smoke/lib/assets/p5-paper.pdf

The page must stay a *single* page with a displayed (own-line, centred) equation
and a bordered table: the layout model labels regions, so a formula that is only
inline in a sentence is a text region and the table needs real cell borders."""

# The runtime is the toolchain interpreter (see the docstring); this file is never
# bundled or imported by the app, so a checker pointed at the workspace interpreter
# cannot resolve matplotlib/docling and that is an environment fact, not a defect —
# the same situation as `resources/research-runtime/worker.py`.
# pyright: reportMissingImports=false

from __future__ import annotations

import sys

import matplotlib

matplotlib.use("pdf")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.backends.backend_pdf import PdfPages  # noqa: E402


def write_page(path: str) -> None:
    with PdfPages(path) as pdf:
        figure = plt.figure(figsize=(8.27, 11.69))
        figure.text(0.09, 0.93, "1  Introduction", fontsize=17, fontweight="bold")
        figure.text(0.09, 0.89, "Deep learning has transformed scientific discovery across many domains.", fontsize=11)
        figure.text(0.09, 0.85, "Prior work studies transfer learning and representation quality.", fontsize=11)
        # Displayed equation: centred, its own line, big — the layout model labels
        # this region `formula` and CodeFormulaV2 turns it into LaTeX.
        figure.text(
            0.20,
            0.75,
            r"$\mathcal{L}(\theta)=\frac{1}{N}\sum_{i=1}^{N}\left(y_i-f_\theta(x_i)\right)^2+\lambda\|\theta\|_2^2$",
            fontsize=20,
        )
        axes = figure.add_axes([0.09, 0.45, 0.72, 0.20])
        axes.axis("off")
        table = axes.table(
            cellText=[["Method", "Accuracy", "F1"], ["Baseline", "0.812", "0.804"], ["Ours", "0.897", "0.891"]],
            loc="center",
            cellLoc="center",
        )
        table.auto_set_font_size(False)
        table.set_fontsize(11)
        table.scale(1.0, 1.6)
        figure.text(0.09, 0.40, "Table 1: Comparison of results on the benchmark.", fontsize=10)
        figure.text(0.09, 0.33, "2  Method")
        figure.text(0.09, 0.29, "We optimize the objective above with stochastic gradient descent.")
        pdf.savefig(figure)
        plt.close(figure)


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "p5-paper.pdf"
    write_page(target)
    print(f"wrote {target}")
