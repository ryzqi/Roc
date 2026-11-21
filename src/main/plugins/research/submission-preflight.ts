import {PDFDocument} from 'pdf-lib';
import {XMLParser, XMLValidator} from 'fast-xml-parser';
import {crc32} from 'node:zlib';
import * as yauzl from 'yauzl';
import {z} from 'zod';
import {
  researchSubmissionProfileReceiptSchema, researchSubmissionPreflightSchema,
  type ResearchSubmissionProfileReceipt, type ResearchSubmissionPreflight
} from '../../../shared/schemas/research-submission-profile';
import {researchJournalCheckSchema} from '../../../shared/schemas/research-journal-compliance';
import {withResearchPdf, extractResearchPdfPageText} from './pdf-render';
import {ArchivePolicy} from './archive-policy';
import {researchContentHash} from './research-files';

type Check = ResearchSubmissionPreflight['checks'][number];
const fileLimit = 64 * 1024 * 1024;
const normalize = (text: string): string => text.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/gu, '').replace(/\s+/gu, ' ').trim().toLowerCase();
const wordNamespaces = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main']);

/** Verify actual selected bytes. Public findings contain locations and counts, never private identity tokens or metadata. */
export async function inspectSubmissionPreflight(input: {
  profile: ResearchSubmissionProfileReceipt; pdf: Uint8Array; files: Array<{path: string; bytes: Uint8Array}>;
  privateIdentityTokens?: string[]; journalChecks?: z.infer<typeof researchJournalCheckSchema>[]; signal?: AbortSignal;
}): Promise<ResearchSubmissionPreflight> {
  const profile = researchSubmissionProfileReceiptSchema.parse(input.profile);
  if (researchContentHash(JSON.stringify(profile.snapshot)) !== profile.snapshotHash) throw new Error('research_submission_profile_snapshot_invalid');
  const tokens = z.string().trim().min(1).max(512).array().max(100).parse(input.privateIdentityTokens ?? []).map(normalize);
  if (input.pdf.length === 0 || input.pdf.length > fileLimit) throw new Error('research_submission_pdf_limit');
  const abort = (): void => input.signal?.throwIfAborted();
  abort();
  const checks: Check[] = [], identities: Array<{slot: string; text: string}> = [];
  const add = (kind: Check['kind'], status: Check['status'], subjectIds: string[], detail: string): void => {checks.push({kind, status, subjectIds, detail});};
  const rules = profile.snapshot.request.profile.rules;
  const journalChecks = input.journalChecks === undefined ? undefined : researchJournalCheckSchema.array().parse(input.journalChecks);
  if (journalChecks === undefined) add('journal_rules', 'manual', [], '尚未复核此配置的正文、引用和图稿规则。');
  else {
    if (journalChecks.length !== rules.length || new Set(journalChecks.map(check => check.ruleId)).size !== rules.length ||
        rules.some(rule => !journalChecks.some(check => check.ruleId === rule.id))) throw new Error('research_submission_journal_checks_incomplete');
    const status = journalChecks.some(check => check.status === 'fail') ? 'fail' : journalChecks.some(check => check.status === 'manual') ? 'manual' : 'pass';
    add('journal_rules', status, journalChecks.flatMap((check, index) => check.status === 'pass' ? [] : [`rule:${index + 1}`]),
      '复用已选配置的正文、引用、图稿和补充文件规则结果；人工项目仍需单独判断。');
  }
  let pages: number;
  try {
    const document = await PDFDocument.load(input.pdf, {updateMetadata: false});
    pages = document.getPageCount();
    if (pages < 1 || pages > 5000) throw new Error('research_submission_pdf_limit');
    identities.push({slot: 'pdf:metadata', text: [document.getTitle(), document.getAuthor(), document.getSubject(),
      document.getKeywords(), document.getCreator(), document.getProducer()].filter(Boolean).join('\n')});
  } catch (error) {
    if (error instanceof Error && error.message === 'research_submission_pdf_limit') throw error;
    throw new Error('research_submission_pdf_invalid');
  }
  const texts: string[] = [];
  try {
    await withResearchPdf(Uint8Array.from(input.pdf), async document => {
      if (document.numPages !== pages) throw new Error('research_submission_pdf_invalid');
      const metadata = await document.getMetadata();
      identities.push({slot: 'pdf:metadata', text: JSON.stringify({info: metadata.info, xmp: metadata.metadata === null ? null : [...metadata.metadata], raw: metadata.metadata?.getRaw()})});
      let size = 0;
      for (let index = 1; index <= pages; index++) {
        abort();
        const page = await document.getPage(index);
        const text = await extractResearchPdfPageText(page, index);
        size += text.length;
        if (size > 5_000_000) throw new Error('research_submission_pdf_text_limit');
        texts.push(text);
        identities.push({slot: `page:${index}`, text}, {slot: `page:${index}:annotations`, text: JSON.stringify(await page.getAnnotations())});
        page.cleanup();
      }
    });
  } catch (error) {
    abort();
    if (error instanceof Error && /^research_submission_/u.test(error.message)) throw error;
    throw new Error('research_submission_pdf_invalid');
  }
  const pdfHash = researchContentHash(Buffer.from(input.pdf));
  const requirements = profile.snapshot.request.requirements, readableText = texts.every(text => text.trim().length > 0);
  add('pages', requirements.maximumPages === null || pages <= requirements.maximumPages ? 'pass' : 'fail', ['pdf:pages'],
    requirements.maximumPages === null ? `编译 PDF 共 ${pages} 页，配置未设上限。` : `编译 PDF 共 ${pages} 页，上限 ${requirements.maximumPages} 页。`);
  const body = normalize(texts.join('\n'));
  const missing = requirements.requiredDeclarations.flatMap((declaration, index) => body.includes(normalize(declaration)) ? [] : [`declaration:${index + 1}`]);
  add('declarations', missing.length === 0 ? 'pass' : readableText ? 'fail' : 'manual', missing,
    '仅检查指定声明文字是否出现在可抽取正文中；不判断其陈述真实性。');
  const policy = new ArchivePolicy({members: 1000, fileBytes: fileLimit, totalBytes: 256 * 1024 * 1024});
  let tables = 0, tableUnknown = false, anonymousUninspected = !readableText;
  const paths = new Set<string>();
  for (const [index, file] of input.files.entries()) {
    abort();
    policy.add({name: file.path, uncompressedSize: file.bytes.length}); paths.add(file.path);
    identities.push({slot: `file:${index + 1}:name`, text: file.path});
    if (file.path === 'paper.pdf') {
      if (researchContentHash(Buffer.from(file.bytes)) !== pdfHash) throw new Error('research_submission_pdf_mismatch');
      continue;
    }
    if (file.path.toLowerCase().endsWith('.docx')) {
      try {
        const document = await inspectSubmissionDocx(file.bytes, input.signal);
        tables += document.tables;
        identities.push({slot: `file:${index + 1}:content`, text: document.text});
      } catch {
        abort(); tableUnknown = true; anonymousUninspected = true;
      }
    } else if (/\.(?:txt|tex|bib|csv|tsv|json|html|htm|svg|xml|md)$/iu.test(file.path)) {
      try {identities.push({slot: `file:${index + 1}:content`, text: new TextDecoder('utf8', {fatal: true}).decode(file.bytes)});}
      catch {anonymousUninspected = true;}
    } else anonymousUninspected = true;
  }
  add('editable_tables', tables >= requirements.minimumEditableTables ? 'pass' : tableUnknown ? 'manual' : 'fail', [],
    `实际 DOCX 中识别到 ${tables} 个原生 Word 表格，要求至少 ${requirements.minimumEditableTables} 个；不把截图或字面表格语法计入。`);
  const supplements = requirements.supplementPaths.flatMap((path, index) => paths.has(path) ? [] : [`supplement:${index + 1}`]);
  add('supplements', supplements.length === 0 ? 'pass' : 'fail', supplements, '按配置逐一核对实际选择的补充文件；未选择的文件不视为已交付。');
  if (!requirements.anonymous) add('anonymity', 'pass', [], '此配置不要求匿名。');
  else {
    const matches = new Set(identities.filter(item => tokens.some(token => normalize(item.text).includes(token))).map(item => item.slot));
    add('anonymity', matches.size > 0 ? 'fail' : tokens.length === 0 || anonymousUninspected ? 'manual' : 'pass', [...matches],
      matches.size > 0 ? `发现 ${matches.size} 处可能的身份信息，位置已遮蔽；请修订后重新核对。` :
        tokens.length === 0 ? '未提供私有身份核查词，匿名性需要人工核对。' :
          '所给身份词未在可检查的正文、元数据、批注和文件名中命中；图像、未知二进制内容及未列出的身份线索仍需人工核对，不能据此保证匿名。');
  }
  abort();
  const files = input.files.map((file, index) => ({subjectId: `file:${index + 1}`, sha256: researchContentHash(Buffer.from(file.bytes)), size: file.bytes.length}));
  const report = {files, profile: {versionId: profile.snapshot.id, expectedHash: profile.snapshotHash},
    pdf: {sha256: pdfHash, size: input.pdf.length, pages, readableText}, checks,
    status: checks.some(check => check.status === 'fail') ? 'fail' as const : checks.some(check => check.status === 'manual') ? 'manual' as const : 'pass' as const};
  return researchSubmissionPreflightSchema.parse({...report, reportHash: researchContentHash(JSON.stringify(report))});
}

/** Count real WordprocessingML tables after bounded ZIP and XML parsing, never text-looking tables. */
export async function inspectSubmissionDocx(bytes: Uint8Array, signal?: AbortSignal): Promise<{tables: number; text: string}> {
  if (bytes.length === 0 || bytes.length > fileLimit) throw new Error('research_submission_docx_limit');
  const zip = await yauzl.fromBufferPromise(Buffer.from(bytes), {lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true});
  const policy = new ArchivePolicy({members: 2000, fileBytes: 16 * 1024 * 1024, totalBytes: fileLimit});
  let document: string | null = null;
  const texts: string[] = [];
  try {
    for await (const entry of zip.eachEntry()) {
      signal?.throwIfAborted();
      const item = policy.add({name: entry.fileName, uncompressedSize: entry.uncompressedSize, directory: entry.fileName.endsWith('/'),
        unixMode: entry.externalFileAttributes >>> 16});
      if (item.directory || !/\.(?:xml|rels)$/iu.test(item.path)) continue;
      const stream = await zip.openReadStreamPromise(entry), chunks: Buffer[] = [];
      let size = 0, checksum = 0;
      for await (const chunk of stream) {
        signal?.throwIfAborted();
        const content = Buffer.from(chunk); size += content.length;
        if (size > 16 * 1024 * 1024) throw new Error('research_submission_docx_limit');
        policy.addOutputBytes(content.length); checksum = crc32(content, checksum); chunks.push(content);
      }
      if (size !== entry.uncompressedSize || checksum !== entry.crc32) throw new Error('research_submission_docx_invalid');
      const text = new TextDecoder('utf8', {fatal: true}).decode(Buffer.concat(chunks));
      if (/<!DOCTYPE|<!ENTITY/iu.test(text) || XMLValidator.validate(text) !== true) throw new Error('research_submission_docx_invalid');
      texts.push(text);
      if (item.path === 'word/document.xml') document = text;
    }
  } finally {zip.close();}
  if (document === null) throw new Error('research_submission_docx_document_required');
  const tree: unknown = new XMLParser({ignoreAttributes: false, processEntities: false, preserveOrder: true}).parse(document);
  let tables = 0, isDocument = false, nodes = 0;
  const walk = (value: unknown, namespaces: Record<string, string>, depth: number): void => {
    if (++nodes > 1_000_000 || depth > 128) throw new Error('research_submission_docx_limit');
    if (!Array.isArray(value)) return;
    for (const node of value) {
      if (typeof node !== 'object' || node === null) continue;
      const object = node as Record<string, unknown>, current = {...namespaces};
      const attributes = object[':@'];
      if (typeof attributes === 'object' && attributes !== null) for (const [name, uri] of Object.entries(attributes)) {
        if (name === '@_xmlns') current[''] = String(uri);
        else if (name.startsWith('@_xmlns:')) current[name.slice(8)] = String(uri);
      }
      for (const [name, children] of Object.entries(object)) {
        const parts = name.split(':'), local = parts.at(-1), prefix = parts.length > 1 ? parts[0] : '';
        if (wordNamespaces.has(current[prefix])) {
          if (local === 'document') isDocument = true;
          if (local === 'tbl') tables++;
        }
        walk(children, current, depth + 1);
      }
    }
  };
  walk(tree, {}, 0);
  if (!isDocument) throw new Error('research_submission_docx_invalid');
  return {tables, text: texts.join('\n')};
}
