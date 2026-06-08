import type { ChatTranscriptActivityBlock } from '../chat-transcript';
import { ToolCallBlock } from './tool-call/ToolCallBlock';

type ToolCallBlockModel = Extract<ChatTranscriptActivityBlock, { kind: 'tool_call' }>;

type ToolCallViewProps = {
  block: ToolCallBlockModel;
};

export function ToolCallView({ block }: ToolCallViewProps): React.JSX.Element {
  return <ToolCallBlock block={block} />;
}
