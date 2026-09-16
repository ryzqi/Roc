"""同一 Matplotlib Figure 的固定格式导出。"""

from dataclasses import dataclass
import json
from pathlib import Path
import random
import runpy
import sys


@dataclass(frozen=True)
class Options:
    width: float
    height: float
    dpi: int
    seed: int

    @classmethod
    def parse(cls, raw: str) -> "Options":
        value = json.loads(raw)
        return cls(value["widthInches"], value["heightInches"], value["dpi"], value["seed"])


def render(source: Path, output: Path, options: Options, arguments: list[str]) -> None:
    import matplotlib
    matplotlib.use("Agg", force=True)
    import matplotlib.pyplot as plt
    from matplotlib.figure import Figure
    import numpy as np

    random.seed(options.seed)
    np.random.seed(options.seed)
    matplotlib.rcdefaults()
    sys.path.insert(0, str(source.parent))
    sys.argv = [str(source), *arguments]
    namespace = runpy.run_path(str(source), run_name="__main__")
    figure = namespace.get("figure")
    if not isinstance(figure, Figure):
        raise ValueError("research_figure_object_required")
    try:
        figure.set_size_inches(options.width, options.height, forward=False)
        # 固定导出尺寸和 SVG 标识；用户仍在源码中控制布局、颜色与字体。
        with matplotlib.rc_context({"svg.hashsalt": str(options.seed), "savefig.bbox": None}):
            figure.savefig(output / "figure.png", format="png", dpi=options.dpi,
                           metadata={"Software": "Roc"})
            figure.savefig(output / "figure.svg", format="svg", dpi=options.dpi,
                           metadata={"Creator": "Roc", "Date": None})
            figure.savefig(output / "figure.pdf", format="pdf", dpi=options.dpi,
                           metadata={"Creator": "Roc", "CreationDate": None, "ModDate": None})
    finally:
        plt.close("all")


def main() -> None:
    operation, source, output, raw_options, *arguments = sys.argv[1:]
    options = Options.parse(raw_options)
    if operation == "render":
        render(Path(source), Path(output), options, arguments)
    else:
        raise ValueError("research_figure_operation_invalid")


if __name__ == "__main__":
    main()
