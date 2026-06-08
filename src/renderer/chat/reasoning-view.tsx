import { ReasoningBlock } from './reasoning/ReasoningBlock';

type ReasoningViewProps = {
  content: string;
  isStreaming: boolean;
};

export function ReasoningView({ content, isStreaming }: ReasoningViewProps): React.JSX.Element {
  return <ReasoningBlock id="legacy-reasoning" content={content} isStreaming={isStreaming} />;
}
