"""同一 Matplotlib Figure 的固定格式导出，以及独立进程中的文件验证。"""

from contextlib import closing
from dataclasses import dataclass
import hashlib
import json
import math
from pathlib import Path
import random
import re
import runpy
import sys
import xml.etree.ElementTree as ET


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


def verify(output: Path, options: Options) -> dict[str, object]:
    from PIL import Image
    import pypdfium2 as pdfium

    files: list[dict[str, object]] = []
    for name in ("figure.png", "figure.svg", "figure.pdf"):
        path = output / name
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 64 * 1024 * 1024:
            raise ValueError("research_figure_file_invalid")
        data = path.read_bytes()
        files.append({"path": name, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)})
    with Image.open(output / "figure.png") as image:
        width, height = image.size
        if image.format != "PNG" or (width, height) != (int(options.width * options.dpi), int(options.height * options.dpi)):
            raise ValueError("research_figure_png_dimensions_invalid")
        image.verify()
    with Image.open(output / "figure.png") as image:
        image.load()
    svg_bytes = (output / "figure.svg").read_bytes()
    if b"<!ENTITY" in svg_bytes.upper():
        raise ValueError("research_figure_svg_entity_invalid")
    svg = ET.fromstring(svg_bytes)
    if svg.tag != "{http://www.w3.org/2000/svg}svg":
        raise ValueError("research_figure_svg_invalid")
    view_box = [float(value) for value in svg.attrib["viewBox"].split()]
    expected_box = [0, 0, options.width * 72, options.height * 72]
    if len(view_box) != 4 or any(not math.isclose(actual, expected, abs_tol=0.01) for actual, expected in zip(view_box, expected_box, strict=True)):
        raise ValueError("research_figure_svg_dimensions_invalid")
    resource_attributes = {"style", "fill", "stroke", "filter", "clip-path", "mask", "marker", "marker-start", "marker-mid", "marker-end", "cursor"}
    for node in svg.iter():
        tag = node.tag.rsplit("}", 1)[-1].lower()
        if tag in {"script", "foreignobject"}:
            raise ValueError("research_figure_svg_active_content")
        for key, value in node.attrib.items():
            if key.rsplit("}", 1)[-1].lower().startswith("on"):
                raise ValueError("research_figure_svg_active_content")
            if key.rsplit("}", 1)[-1] == "href" and not (value.startswith("#") or value.startswith("data:image/png;base64,")):
                raise ValueError("research_figure_svg_external_resource")
        styles = [value for key, value in node.attrib.items() if key.rsplit("}", 1)[-1] in resource_attributes]
        if tag == "style":
            styles.append(node.text or "")
        content = " ".join(styles)
        targets = re.findall(r"url\(\s*([^)]*?)\s*\)", content, re.IGNORECASE)
        if "@import" in content.lower() or any(not target.strip(" \t\r\n\"'").startswith("#") for target in targets):
            raise ValueError("research_figure_svg_external_resource")
    with closing(pdfium.PdfDocument(output / "figure.pdf")) as document:
        if len(document) != 1:
            raise ValueError("research_figure_pdf_page_count_invalid")
        with closing(document[0]) as page:
            width_points, height_points = page.get_size()
            if not math.isclose(width_points, options.width * 72, abs_tol=0.01) or not math.isclose(height_points, options.height * 72, abs_tol=0.01):
                raise ValueError("research_figure_pdf_dimensions_invalid")
            with closing(page.render(scale=1)) as bitmap:
                if bitmap.width < 1 or bitmap.height < 1:
                    raise ValueError("research_figure_pdf_render_invalid")
    return {"widthPixels": width, "heightPixels": height, "widthPoints": width_points,
            "heightPoints": height_points, "pageCount": 1, "files": files}


def main() -> None:
    operation, source, output, raw_options, *arguments = sys.argv[1:]
    options = Options.parse(raw_options)
    if operation == "render":
        render(Path(source), Path(output), options, arguments)
    elif operation == "verify":
        print(json.dumps(verify(Path(output), options), ensure_ascii=False, allow_nan=False))
    else:
        raise ValueError("research_figure_operation_invalid")


if __name__ == "__main__":
    main()
