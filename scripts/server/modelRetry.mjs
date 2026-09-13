const defaultInitialRetryDelayMilliseconds = 1000;
const defaultMaximumRetryDelayMilliseconds = 30 * 1000;
const requestAbortedMarker = "Request aborted";

class RetryableModelResponseError extends Error {}

export function modelErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function isRetryableModelFetchError(error) {
  return error instanceof RetryableModelResponseError || modelErrorMessage(error).includes("fetch failed");
}

export function throwIfRetryableModelOutput(...outputs) {
  const abortedOutput = outputs.find((output) => output.includes(requestAbortedMarker));
  if (!abortedOutput) return;

  const markerStartIndex = abortedOutput.indexOf(requestAbortedMarker);
  const lineStartIndex = abortedOutput.lastIndexOf("\n", markerStartIndex) + 1;
  const lineEndIndex = abortedOutput.indexOf("\n", markerStartIndex);
  const errorOutput = abortedOutput.slice(lineStartIndex, lineEndIndex < 0 ? undefined : lineEndIndex).trim();
  throw new RetryableModelResponseError(`Model request failed: ${errorOutput}`);
}

export function throwIfModelResponseError(errorPayload) {
  if (!errorPayload) return;

  const errorDetails = typeof errorPayload === "object" ? errorPayload : {};
  const errorCode = String(errorDetails.code ?? errorDetails.type ?? "server_error");
  const errorMessage = String(errorDetails.message ?? errorPayload);
  const message = `Model request failed: ${errorCode}: ${errorMessage}`;
  if (errorCode === "insufficient_memory" || errorDetails.type === "insufficient_memory") {
    throw new RetryableModelResponseError(message);
  }
  throw new Error(message);
}

async function createRetryableModelResponseError(response) {
  const responseText = await response.text().catch(() => "");
  return new RetryableModelResponseError(`Model request failed: HTTP ${response.status} ${responseText.slice(0, 1000)}`);
}

function createAbortError() {
  const error = new Error("Model request aborted.");
  error.name = "AbortError";
  return error;
}

async function waitForRetryDelay(retryDelayMilliseconds, signal) {
  if (retryDelayMilliseconds <= 0) return;
  await new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : createAbortError());
      return;
    }

    const handleAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason instanceof Error ? signal.reason : createAbortError());
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, retryDelayMilliseconds);

    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

export async function fetchModelResponseWithRetry({
  fetchImplementation,
  requestUrl,
  requestOptions,
  signal,
  shouldStop = () => false,
  onRetry = () => {},
  processResponse = (response) => response,
  initialRetryDelayMilliseconds = defaultInitialRetryDelayMilliseconds,
  maximumRetryDelayMilliseconds = defaultMaximumRetryDelayMilliseconds
}) {
  let attemptNumber = 1;
  let retryDelayMilliseconds = initialRetryDelayMilliseconds;

  while (true) {
    try {
      const response = await fetchImplementation(requestUrl, requestOptions);
      if (response.status === 507) {
        throw await createRetryableModelResponseError(response);
      }
      return await processResponse(response);
    } catch (error) {
      if (signal?.aborted || shouldStop() || !isRetryableModelFetchError(error)) {
        throw error;
      }

      onRetry({
        attemptNumber,
        errorMessage: modelErrorMessage(error),
        retryDelayMilliseconds
      });
      await waitForRetryDelay(retryDelayMilliseconds, signal);
      attemptNumber += 1;
      retryDelayMilliseconds = Math.min(retryDelayMilliseconds * 2, maximumRetryDelayMilliseconds);
    }
  }
}