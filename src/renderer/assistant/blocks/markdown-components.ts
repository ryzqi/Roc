import { CodeBlock } from './code-block';
import { MarkdownImage } from './markdown-image';
import { MarkdownLink } from './markdown-link';

/** Components shared by the settled and streaming Markdown parsers. */
export const markdownComponents = { a: MarkdownLink, img: MarkdownImage, pre: CodeBlock };
