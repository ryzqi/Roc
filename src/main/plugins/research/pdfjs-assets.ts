import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const pdfRequire = createRequire(import.meta.url);
const pdfjsRoot = dirname(pdfRequire.resolve('pdfjs-dist/package.json'));

export type PdfjsAssetDirectory = 'cmaps' | 'standard_fonts' | 'wasm';

/**
 * pdf.js 6 的资源目录（CMap / 标准字体 / wasm）——**文件系统路径**，不是 `file://` URL。
 *
 * ## 为什么不能是 URL
 *
 * Node 侧的 `getDocument` 会为这三个目录建 `NodeBinaryDataFactory`，它的 `_fetch` 是
 * `fs.readFile(url)`，url 由「目录 + 文件名」拼成。传 `file:///…` 时 `readFile` 找不到文件，
 * 于是 `translateFont` 退回内置拉丁字面：**中文/CID 字体抽不出文字**，只有警告
 *（`Unable to load CMap data at: file://…`），正文静默缺字。这一层以前就错着，
 * 结果就是中文 PDF 的文本抽取、图表校验和科研 smoke 都拿不到 CJK 内容。
 *
 * 结尾必须有斜杠：`getFactoryUrlProp` 直接拒绝不带斜杠的目录。
 * 渲染层不受影响——那边是浏览器上下文，走 fetch 与 `files.preview*` 协议。
 */
export function pdfjsAssetDirectory(directory: PdfjsAssetDirectory): string {
  return `${join(pdfjsRoot, directory)}/`;
}
