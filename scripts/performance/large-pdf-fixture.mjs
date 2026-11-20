import {createHash} from 'node:crypto';
import {open} from 'node:fs/promises';
import {createPerformancePdf} from '../lib/research-pdf-performance-fixture.mjs';

/** Valid 400-page PDF with inert comments and the original xref repeated at EOF. */
export async function writeLargePerformancePdf(path, size) {
  const original = createPerformancePdf();
  const xref = /startxref\n(\d+)\n%%EOF/u.exec(original.toString())[1];
  const tail = Buffer.from(`\nstartxref\n${xref}\n%%EOF\n`);
  const padding = Buffer.from(`%${'x'.repeat(65533)}\n`);
  const file = await open(path, 'wx', 0o600), hash = createHash('sha256');
  let written = 0;
  const write = async bytes => {
    hash.update(bytes);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.write(bytes, offset, bytes.length - offset);
      if (result.bytesWritten === 0) throw new Error('performance_pdf_write_incomplete');
      offset += result.bytesWritten;
    }
    written += bytes.length;
  };
  try {
    await write(original);
    while (written < size - tail.length) await write(padding.subarray(0, Math.min(padding.length, size - tail.length - written)));
    await write(tail);
    return {sha256: hash.digest('hex'), size: written, pages: 400, padding: 'PDF comments; repeated original startxref'};
  } finally {await file.close();}
}
