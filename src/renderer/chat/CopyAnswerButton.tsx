import { Check, Copy } from 'lucide-react';
import { useCopyContent } from './activity-block/use-copy-content';

interface CopyAnswerButtonProps {
  content: string;
}

export function CopyAnswerButton({ content }: CopyAnswerButtonProps): React.JSX.Element {
  const { copied, copy } = useCopyContent(() => content);

  return (
    <div className="chat-answer-actions">
      <button
        aria-label={copied ? '已复制回答' : '复制回答'}
        className="copy-answer-button"
        onClick={copy}
        type="button"
      >
        {copied ? <Check aria-hidden="true" size={14} /> : <Copy aria-hidden="true" size={14} />}
        <span>{copied ? '已复制' : '复制回答'}</span>
      </button>
    </div>
  );
}
