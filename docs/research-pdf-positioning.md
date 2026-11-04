# Research PDF positioning contract

## Measured coordinate frames

Parser bounding boxes are XYXY rectangles in the actual rendered raster, with a top-left
origin. They are not PDF user-space coordinates. PaddleOCR1.2.0 crops regions using
x2-x1/y2-y1; native text uses the full measured raster bounds. The PDF renderer requests
scale1.5 but clamps oversized viewports to25,000,000 pixels, then rounds bitmap dimensions.
A page rotation, CropBox offset or UserUnit changes the PDF-to-raster affine transform.

New middle/structured JSON records coordinateFrameContractVersion1 and a coordinateFrame
for each processed page. A PDF frame preserves raster width/height and the actual PDF.js6.4.299
viewport width/height, scale, rotation, UserUnit, viewBox and six affine matrix values. Image
frames contain only their actual raster basis; HTML records null. No coordinate basis is
invented for an old source or unavailable metadata.

projectParsedRegionToPdf validates a nonempty region within the captured raster and inverts
the saved viewport transform. Bottom-left raw regions are reflected within the recorded raster
before inversion. The output is a PDF user-space XYXY rectangle; consumers must apply the
actual destination viewport when drawing it. Rotation and nondefault scale are never inferred
from a locator string, filename or a universal1.5 ratio.

A malformed frame, singular/nonfinite transform or invalid/out-of-raster region is an error.
A missing basis cannot produce a guessed region; the reader must explicitly use page-only
location. Frame capture does not approve scientific support or migrate a source to a new parse.

## Verification and current limits

Actual generated PDFs with crop[20,30,500,700], rotations90/270, UserUnit2 and a12000x15000
page are parsed through the real PDF.js path. Projection matches independent
PageViewport.convertToPdfPoint results, including bottom-left regions. The large page records
actual scale0.37267799624996495 rather than1.5. Native text without a page image and the
actual OCR raster renderer share the same measured-frame path.

Evidence is retained under .artifacts/research-optimization/pr07-coordinates/actual-parser-frames.json.
SourceLocator, old parse content and frozen research-workflow fixture files remain unchanged.
Renderer metadata/preview integration, selection annotations and large-PDF page resource
acceptance remain subsequent PR-07 increments.

Primary API reference: https://github.com/mozilla/pdf.js/blob/v6.4.299/docs/contents/examples/index.md
Installed implementation: pdfjs-dist6.4.299 PageViewport and paddleocr1.2.0 structure pipeline.

## Atomic coordinate snapshot publication

Research DB25 stores coordinate snapshots separately from the original parse JSON. New captures
bind sourceHash, canonical parsed-content SHA, processed-page frames and exact structured artifact
path/hash/size. collectDocumentContent normalizes through the persisted schema before hashing.
Its result carries data and an explicit nullable coordinate input; complete requires that input.
Synthetic or historical page-only records explicitly use null, with no old write-signature alias.

Parse completion, coordinate insertion/hash marker, index replacement and previous source
invalidation share a transaction. Insertion failure retains the old parse/index/source and queues
no phantom publication. New parse records carry coordinate_snapshot_hash, allowing a lost snapshot
to raise a missing-data error. Stored-frame corruption, changed source/parse, wrong page/region
or an unexpected snapshot also fail. Existing rows receive only a null marker; no old parse JSON,
Evidence, user predecessor selection or scientific history is rewritten and no frame is invented.

Marked current structured artifacts must provide valid matching frames. Markerless historical
artifacts have no captured basis and cannot be projected to a region. Coordinates are read by
fixed document/parse identity; a later parse never replaces the old saved snapshot during reads.
File-byte validation at the preview boundary and renderer metadata exposure follow next.
