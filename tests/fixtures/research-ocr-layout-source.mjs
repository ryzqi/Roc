import {createCanvas} from '@napi-rs/canvas';
import {deflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

/** CC0 controlled layout corpus, separate from the frozen text/table/formula source. */
export async function materializeOcrLayoutSource(root) {
  await mkdir(root, {recursive: true});
  const width = 1200, height = 1600, pages = [];
  const page = title => {
    const canvas = createCanvas(width, height), context = canvas.getContext('2d');
    context.fillStyle = '#fff'; context.fillRect(0, 0, width, height);
    context.fillStyle = '#000'; context.font = 'bold 40px Arial';
    context.fillText(title, 70, 100);
    return {canvas, context};
  };
  const bilingual = page('Controlled bilingual text');
  const bilingualLines = [
    'Synthetic group A has 8 samples.',
    '合成甲组共有八个样本。',
    'The measured difference is 2.00 mg/L.',
    '测量差值为 2.00 毫克每升。',
    'Preserve the original source and every unit.',
    '保留原始来源以及每个计量单位。'
  ];
  bilingual.context.font = '34px Arial, "PingFang SC"';
  bilingualLines.forEach((line, index) => bilingual.context.fillText(line, 70, 220 + index * 100));
  pages.push(bilingual.canvas);
  const columns = page('Controlled two-column layout');
  columns.context.font = '30px Arial';
  const left = ['Left column group A.', 'Eight synthetic samples.', 'Mean is 2.00 mg/L.', 'Preserve reading order.'];
  const right = ['Right column group B.', 'Eight synthetic samples.', 'Mean is 4.00 mg/L.', 'Compare source images.'];
  left.forEach((line, index) => columns.context.fillText(line, 70, 260 + index * 110));
  right.forEach((line, index) => columns.context.fillText(line, 650, 260 + index * 110));
  pages.push(columns.canvas);
  const mixed = page('Controlled text and figure');
  mixed.context.font = '32px Arial';
  mixed.context.fillText('Figure 1. Synthetic outcome comparison.', 70, 220);
  mixed.context.fillText('A is 2.00 mg/L and B is 4.00 mg/L.', 70, 300);
  mixed.context.lineWidth = 3;
  mixed.context.beginPath(); mixed.context.moveTo(180, 500);
  mixed.context.lineTo(180, 1020); mixed.context.lineTo(1020, 1020); mixed.context.stroke();
  mixed.context.fillStyle = '#666'; mixed.context.fillRect(320, 780, 180, 240);
  mixed.context.fillStyle = '#aaa'; mixed.context.fillRect(700, 540, 180, 480);
  mixed.context.fillStyle = '#000'; mixed.context.fillText('A', 395, 1080); mixed.context.fillText('B', 775, 1080);
  mixed.context.fillText('Source image review remains necessary.', 70, 1250);
  pages.push(mixed.canvas);

  const objects = [Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from(`<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ')}] /Count ${pages.length} >>`)];
  for (const [index, canvas] of pages.entries()) {
    try {
      await writeFile(join(root, `source-page-${index + 1}.png`), await canvas.encode('png'));
      const rgba = canvas.getContext('2d').getImageData(0, 0, width, height).data;
      const rgb = Buffer.alloc(width * height * 3);
      for (let pixel = 0; pixel < width * height; pixel++) {
        rgb[pixel * 3] = rgba[pixel * 4]; rgb[pixel * 3 + 1] = rgba[pixel * 4 + 1]; rgb[pixel * 3 + 2] = rgba[pixel * 4 + 2];
      }
      const compressed = deflateSync(rgb), content = Buffer.from('q 612 0 0 792 0 0 cm /Scan Do Q');
      objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Scan ${5 + index * 3} 0 R >> >> /Contents ${4 + index * 3} 0 R >>`),
        Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from('\nendstream')]),
        Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`),
          compressed, Buffer.from('\nendstream')]));
    } finally {
      canvas.width = 0; canvas.height = 0;
    }
  }
  const parts = [Buffer.from('%PDF-1.7\n')], offsets = [0]; let offset = parts[0].length;
  objects.forEach((object, index) => {
    offsets.push(offset);
    const part = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')]);
    parts.push(part); offset += part.length;
  });
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(value => `${String(value).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
  const bytes = Buffer.concat(parts), sourcePath = join(root, 'source.pdf');
  await writeFile(sourcePath, bytes);
  const truth = {kind: 'controlled engineering fixture; not calibrated scientific accuracy',
    pages: 3, bilingualLines, leftColumn: left, rightColumn: right,
    mixed: ['Figure 1. Synthetic outcome comparison.', 'A is 2.00 mg/L and B is 4.00 mg/L.'],
    sourceHash: createHash('sha256').update(bytes).digest('hex')};
  await writeFile(join(root, 'source-truth.json'), JSON.stringify(truth, null, 2));
  return {sourcePath, truth};
}
