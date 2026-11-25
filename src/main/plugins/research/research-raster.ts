import {createCanvas, loadImage} from '@napi-rs/canvas';
import * as UTIF from 'utif';
import {researchJobError} from './research-job';

const MAX_PAGE_PIXELS = 25_000_000;
export type Raster = {width: number; height: number; data: Uint8Array};

type RasterDocument = { pageCount: number; page(pageNumber: number): Promise<Raster> };

export async function decodeRasterDocument(source: Buffer, extension: string): Promise<RasterDocument> {
  extension = extension.toLowerCase();
  if (extension === '.tif' || extension === '.tiff') {
    const buffer = toArrayBuffer(source);
    const pages = UTIF.decode(buffer);
    if (pages.length === 0) researchJobError('research_image_decode_failed');
    const dimensions = pages.map((directory) => {
      const widthTag = directory.t256;
      const heightTag = directory.t257;
      const width = Array.isArray(widthTag) && typeof widthTag[0] === 'number' ? widthTag[0] : undefined;
      const height = Array.isArray(heightTag) && typeof heightTag[0] === 'number' ? heightTag[0] : undefined;
      assertRasterSize(width, height);
      return { width, height };
    });
    return {
      pageCount: pages.length,
      page: async (pageNumber) => {
        const directory = pages[pageNumber - 1];
        const expectedDimensions = dimensions[pageNumber - 1];
        if (directory === undefined || expectedDimensions === undefined) researchJobError('research_image_page_invalid');
        try {
          UTIF.decodeImage(buffer, directory);
          const width = directory.width;
          const height = directory.height;
          assertRasterSize(width, height);
          if (width !== expectedDimensions.width || height !== expectedDimensions.height) {
            researchJobError('research_image_decode_failed');
          }
          const data = UTIF.toRGBA8(directory);
          if (data.byteLength !== width * height * 4) researchJobError('research_image_pixel_buffer_invalid');
          return { width, height, data };
        } finally {
          directory.data = new Uint8Array(0);
        }
      }
    };
  }
  const image = await loadImage(source);
  assertRasterSize(image.width, image.height);
  const canvas = createCanvas(image.width, image.height);
  try {
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, image.width, image.height);
    const imageData = context.getImageData(0, 0, image.width, image.height).data;
    const raster = { width: image.width, height: image.height,
      data: new Uint8Array(imageData.buffer, imageData.byteOffset, imageData.byteLength) };
    return {
      pageCount: 1,
      page: async (pageNumber) => {
        if (pageNumber !== 1) researchJobError('research_image_page_invalid');
        return raster;
      }
    };
  } finally {canvas.width = 0; canvas.height = 0;}
}

export async function imagePng(image: Raster): Promise<Buffer> {
  assertRasterSize(image.width, image.height);
  const canvas = createCanvas(image.width, image.height);
  try {
    const context = canvas.getContext('2d');
    const imageData = context.createImageData(image.width, image.height);
    if (image.data.byteLength === image.width * image.height * 4) {
      imageData.data.set(image.data);
    } else if (image.data.byteLength === image.width * image.height * 3) {
      for (let source = 0, target = 0; source < image.data.length; source += 3, target += 4) {
        imageData.data[target] = image.data[source];
        imageData.data[target + 1] = image.data[source + 1];
        imageData.data[target + 2] = image.data[source + 2];
        imageData.data[target + 3] = 255;
      }
    } else if (image.data.byteLength === image.width * image.height) {
      for (let source = 0, target = 0; source < image.data.length; source += 1, target += 4) {
        const value = image.data[source];
        imageData.data[target] = value;
        imageData.data[target + 1] = value;
        imageData.data[target + 2] = value;
        imageData.data[target + 3] = 255;
      }
    } else {
      researchJobError('research_image_pixel_buffer_invalid');
    }
    context.putImageData(imageData, 0, 0);
    return await canvas.encode('png');
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

function assertRasterSize(width: number | undefined, height: number | undefined): void {
  if (width === undefined || height === undefined || !Number.isInteger(width) || !Number.isInteger(height)
    || width < 1 || height < 1 || width * height > MAX_PAGE_PIXELS) {
    researchJobError('research_image_too_large');
  }
}

function toArrayBuffer(bytes: Buffer): ArrayBuffer {
  const buffer = bytes.buffer;
  if (buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === buffer.byteLength) return buffer;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

