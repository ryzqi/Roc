import { useState } from 'react';

export function FileImageFrame({
  alt,
  imageTestId,
  src,
  stageTestId
}: {
  alt: string;
  imageTestId?: string;
  src: string;
  stageTestId?: string;
}): React.JSX.Element {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const failed = failedSrc === src;
  return (
    <div className="workbench-file-image-stage" data-testid={stageTestId}>
      {failed ? (
        <p className="workbench-file-image-fallback">{alt} 没有加载。重新打开这个文件后再看。</p>
      ) : (
        <img
          alt={alt}
          className="workbench-file-image-preview"
          data-testid={imageTestId}
          src={src}
          onError={() => setFailedSrc(src)}
        />
      )}
    </div>
  );
}
