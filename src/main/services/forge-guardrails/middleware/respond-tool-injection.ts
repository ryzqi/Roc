import { AIMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import { createRespondTool, RESPOND_TOOL_NAME } from '../respond-tool';
import { tagForgeMessage } from '../message-tags';

export function createRespondToolInjectionMiddleware(opts: { enabled: boolean }) {
  return createMiddleware({
    name: 'ForgeRespondToolInjection',
    async wrapModelCall(request, handler) {
      if (!opts.enabled) {
        return handler(request);
      }

      const respondTool = createRespondTool();
      const response = await handler({
        ...request,
        tools: [...request.tools, respondTool]
      });

      if (!AIMessage.isInstance(response)) {
        return response;
      }

      const toolCalls = response.tool_calls;
      if (toolCalls === undefined || toolCalls.length === 0) {
        return response;
      }
      const respondCalls = toolCalls.filter((toolCall) => toolCall.name === RESPOND_TOOL_NAME);
      if (respondCalls.length === 0) {
        return response;
      }
      if (respondCalls.length > 1) {
        console.warn('[ForgeRespondToolInjection] Multiple respond calls in one AIMessage; using first.');
      }

      const firstRespondCall = respondCalls[0];
      const respondMessage = firstRespondCall.args.message;
      const message = typeof respondMessage === 'string' ? respondMessage : '';
      const otherCalls = toolCalls.filter((toolCall) => toolCall.name !== RESPOND_TOOL_NAME);
      const rebuilt = new AIMessage({
        id: response.id,
        content: message,
        tool_calls: otherCalls,
        additional_kwargs: { ...response.additional_kwargs },
        response_metadata: response.response_metadata,
        usage_metadata: response.usage_metadata
      });
      return tagForgeMessage(rebuilt, 'forge:respond_synthetic');
    }
  });
}
