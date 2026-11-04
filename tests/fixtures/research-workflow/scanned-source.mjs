import {createCanvas} from '@napi-rs/canvas';
import {deflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

/** Controlled raster-only source with independent text/table/formula truth, never a scientific result. */
export async function materializeScannedSource(root) {
  await mkdir(root,{recursive:true});
  const width=1200,height=1600,pages=[];
  const page=title=>{
    const canvas=createCanvas(width,height),context=canvas.getContext('2d');
    context.fillStyle='#ffffff';context.fillRect(0,0,width,height);
    context.fillStyle='#000000';context.font='bold 42px Arial';context.fillText(title,90,100);
    return {canvas,context};
  };
  const first=page('Controlled scanned source');
  first.context.font='34px Arial';
  const lines=['Synthetic group A mean is 2.00.',
    'Synthetic group B mean is 4.00.',
    'The difference is 2.00 mg/L.',
    'These numbers are fixture truth, not a scientific claim.',
    'Original image review must preserve the source version.'];
  lines.forEach((line,index)=>first.context.fillText(line,90,220+index*80));
  pages.push(first.canvas);
  const second=page('Table 1. Controlled outcome comparison');
  const x=[90,350,560,780,1100],y=[220,300,380,480,580,680,780,880];
  const context=second.context;
  context.lineWidth=3;
  for(const left of x){context.beginPath();context.moveTo(left,y[0]);context.lineTo(left,y.at(-1));context.stroke();}
  for(const top of y){context.beginPath();context.moveTo(x[0],top);context.lineTo(x.at(-1),top);context.stroke();}
  context.fillStyle='#ffffff';context.fillRect(x[1]+2,y[0]+2,x[3]-x[1]-4,y[1]-y[0]-4);
  context.fillStyle='#000000';context.font='bold 30px Arial';context.fillText('Mean (SD)',x[1]+90,270);
  const rows=[
    ['Group','n','Mean','SD'],
    ['A','8','2.00','0.12'],
    ['B','8','4.00','0.25'],
    ['A repeat','8','2.10','0.15'],
    ['B repeat','8','4.20','0.30'],
    ['Difference','16','2.00','0.28']
  ];
  context.font='30px Arial';
  rows.forEach((row,index)=>row.forEach((cell,column)=>context.fillText(cell,x[column]+16,y[index+1]+55)));
  context.fillText('Unit: mg/L. SD means standard deviation.',90,1020);
  context.fillText('Merged header and repeated groups require human review.',90,1100);
  pages.push(second.canvas);
  const third=page('Equation 1. Controlled arithmetic mean');
  third.context.font='italic 62px Times New Roman';
  third.context.fillText('x',150,420);
  third.context.lineWidth=3;third.context.beginPath();third.context.moveTo(148,366);third.context.lineTo(183,366);third.context.stroke();
  third.context.fillText('=',230,420);
  third.context.fillText('1',335,390);third.context.fillText('n',331,470);
  third.context.beginPath();third.context.moveTo(313,416);third.context.lineTo(380,416);third.context.stroke();
  third.context.font='76px Times New Roman';third.context.fillText('∑',435,432);
  third.context.font='28px Times New Roman';third.context.fillText('n',460,343);third.context.fillText('i = 1',440,480);
  third.context.font='italic 62px Times New Roman';third.context.fillText('x',565,420);
  third.context.font='28px Times New Roman';third.context.fillText('i',594,440);
  third.context.font='32px Arial';
  third.context.fillText('Example: (1 + 3) / 2 = 2.00.',90,680);
  third.context.fillText('Confirm every symbol, subscript and unit from the image.',90,760);
  pages.push(third.canvas);
  const objects=[Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from(`<< /Type /Pages /Kids [${pages.map((_,i)=>`${3+i*3} 0 R`).join(' ')}] /Count ${pages.length} >>`)];
  for(const [index,canvas] of pages.entries()) {
    await writeFile(join(root,`source-page-${index+1}.png`),await canvas.encode('png'));
    const rgba=canvas.getContext('2d').getImageData(0,0,width,height).data,rgb=Buffer.alloc(width*height*3);
    for(let pixel=0;pixel<width*height;pixel++) {
      rgb[pixel*3]=rgba[pixel*4];rgb[pixel*3+1]=rgba[pixel*4+1];rgb[pixel*3+2]=rgba[pixel*4+2];
    }
    const compressed=deflateSync(rgb),content=Buffer.from('q 612 0 0 792 0 0 cm /Scan Do Q');
    objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Scan ${5+index*3} 0 R >> >> /Contents ${4+index*3} 0 R >>`),
      Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`),content,Buffer.from('\nendstream')]),
      Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`),
        compressed,Buffer.from('\nendstream')]));
  }
  const parts=[Buffer.from('%PDF-1.7\n')],offsets=[0];let offset=parts[0].length;
  objects.forEach((object,index)=>{
    offsets.push(offset);
    const part=Buffer.concat([Buffer.from(`${index+1} 0 obj\n`),object,Buffer.from('\nendobj\n')]);
    parts.push(part);offset+=part.length;
  });
  parts.push(Buffer.from(`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(value=>`${String(value).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
  const bytes=Buffer.concat(parts),sourcePath=join(root,'source.pdf');
  await writeFile(sourcePath,bytes);
  const truth={kind:'controlled engineering fixture; no scientific accuracy claim',pages:3,lines,
    table:{headers:['Group','n','Mean','SD'],rows,unit:'mg/L',mergedHeader:'Mean (SD)'},
    formula:{description:'arithmetic mean with bar, fraction, sum bounds and subscript',example:'(1 + 3) / 2 = 2.00'},
    sourceHash:createHash('sha256').update(bytes).digest('hex')};
  await writeFile(join(root,'source-truth.json'),JSON.stringify(truth,null,2));
  return {sourcePath,truth};
}
