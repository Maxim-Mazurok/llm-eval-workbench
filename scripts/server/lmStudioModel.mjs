function lmStudioWebSocketBaseUrl(baseUrl) {
  const endpointUrl = new URL(baseUrl);
  const protocol = endpointUrl.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${endpointUrl.host}`;
}

function finishReasonFromStopReason(stopReason) {
  if (stopReason === "maxPredictedTokensReached" || stopReason === "contextLengthReached") {
    return "length";
  }
  return "stop";
}

function enqueueCompletionPayload(controller, encoder, payload) {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
}

export function createLmStudioChatCompletionResponse({
  baseUrl,
  apiKey,
  model,
  messages,
  predictionConfig,
  signal,
  clientFactory
}) {
  const encoder = new TextEncoder();
  let prediction;
  let client;

  const body = new ReadableStream({
    async start(controller) {
      let reasoningTokens = 0;
      let outputTokens = 0;
      const cancelPrediction = () => prediction?.cancel().catch(() => undefined);

      try {
        const resolvedClientFactory = clientFactory ?? (async (clientOptions) => {
          const { LMStudioClient } = await import("@lmstudio/sdk");
          return new LMStudioClient(clientOptions);
        });
        client = await resolvedClientFactory({
          baseUrl: lmStudioWebSocketBaseUrl(baseUrl),
          ...(apiKey ? { apiToken: apiKey } : {})
        });
        const modelHandle = await client.llm.model(model);
        prediction = modelHandle.respond(messages, predictionConfig);
        signal?.addEventListener("abort", cancelPrediction, { once: true });

        for await (const fragment of prediction) {
          if (fragment.reasoningType === "reasoning") {
            reasoningTokens += fragment.tokensCount;
            enqueueCompletionPayload(controller, encoder, {
              choices: [{ delta: { reasoning: fragment.content } }]
            });
          } else if (fragment.reasoningType === "none") {
            outputTokens += fragment.tokensCount;
            enqueueCompletionPayload(controller, encoder, {
              choices: [{ delta: { content: fragment.content } }]
            });
          }
        }

        const result = await prediction.result();
        const promptTokens = result.stats.promptTokensCount;
        const completionTokens = result.stats.predictedTokensCount ?? reasoningTokens + outputTokens;
        enqueueCompletionPayload(controller, encoder, {
          choices: [{ delta: {}, finish_reason: finishReasonFromStopReason(result.stats.stopReason) }],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens === undefined ? undefined : promptTokens + completionTokens,
            completion_tokens_details: { reasoning_tokens: reasoningTokens }
          }
        });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        signal?.removeEventListener("abort", cancelPrediction);
        await client?.[Symbol.asyncDispose]?.().catch(() => undefined);
      }
    },
    cancel() {
      return prediction?.cancel();
    }
  });

  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}