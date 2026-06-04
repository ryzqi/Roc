import type { RocClient } from '../../shared/roc-client';
import { ChatView, type ChatViewProps } from '../../chat/chat-view';

export type ChatFeatureProps = ChatViewProps & {
  client: RocClient;
};

export function ChatFeature({ client, ...props }: ChatFeatureProps): React.JSX.Element {
  return <ChatView {...props} client={client} />;
}
