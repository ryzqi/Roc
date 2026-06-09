import { Check, Copy } from 'lucide-react';
import { useCopyContent } from './activity-block/use-copy-content';

interface CopyAnswerButtonProps {
  content: string;
}

export function CopyAnswerButton({ content }: CopyAnswerButtonProps): React.JSX.Element {
  const { copied, copy } = useCopyContent(() => content);
  const label = copied ? '已复制回答' : '复制回答';

  return (
    <button
      aria-label={label}
      className="copy-answer-button copy-answer-button--icon-only"
      onClick={copy}
      title={label}
      type="button"
    >
      {copied ? <Check aria-hidden="true" size={16} /> : <Copy aria-hidden="true" size={16} />}
    </button>
  );
}
