import { type BenchResult } from "./benchmark";

export type BenchmarkMentionSignal = {
  regex: string;
  matchedText: string;
  excerpt: string;
  channel: "output" | "thinking" | "transcript" | "extracted";
};

function compileRegex(pattern: string) {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

function answerChannels(result?: BenchResult): BenchmarkMentionSignal["channel"][] {
  if (!result) return [];
  return ["output", "thinking", "transcript", "extracted"];
}

function answerText(result: BenchResult, channel: BenchmarkMentionSignal["channel"]) {
  switch (channel) {
    case "output":
      return result.rawOutput || "";
    case "thinking":
      return result.thinkingOutput || "";
    case "transcript":
      return result.rawTranscript || "";
    case "extracted":
      return result.extractedCode || "";
  }
}

function excerptForMatch(text: string, start: number, end: number) {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const nextBreak = text.indexOf("\n", end);
  const lineEnd = nextBreak === -1 ? text.length : nextBreak;
  return text.slice(lineStart, lineEnd).trim();
}

export function analyzeBenchmarkMention(result: BenchResult | undefined, regex: string): BenchmarkMentionSignal | undefined {
  if (!result) return undefined;
  const matcher = compileRegex(regex);
  if (!matcher) return undefined;
  for (const channel of answerChannels(result)) {
    const text = answerText(result, channel);
    if (!text) continue;
    const match = matcher.exec(text);
    if (!match || match.index < 0) continue;
    return {
      regex,
      matchedText: match[0],
      excerpt: excerptForMatch(text, match.index, match.index + match[0].length),
      channel
    };
  }
  return undefined;
}

export function benchmarkMentionIsFlagged(signal: BenchmarkMentionSignal | undefined) {
  return Boolean(signal?.matchedText);
}

export function benchmarkMentionStats(results: BenchResult[] = [], regex: string) {
  const flagged = results.filter((result) => benchmarkMentionIsFlagged(analyzeBenchmarkMention(result, regex))).length;
  return { flagged, total: results.length };
}

export function formatBenchmarkMentionSignal(signal: BenchmarkMentionSignal | undefined) {
  if (!signal) return "No benchmark-name mention signal recorded for this result.";
  return [
    "FLAGGED: answer mentioned the benchmark name.",
    `Regex: /${signal.regex}/i`,
    `Channel: ${signal.channel}`,
    `Matched text: ${signal.matchedText}`,
    `Excerpt: ${signal.excerpt || "(blank line)"}`
  ].join("\n");
}

export function benchmarkMentionResultNumbers(resultsRun: { results: BenchResult[] } | null, flagged: boolean, regex: string) {
  return (resultsRun?.results ?? [])
    .filter((result) => benchmarkMentionIsFlagged(analyzeBenchmarkMention(result, regex)) === flagged)
    .map((result) => result.index)
    .sort((a, b) => a - b)
    .join(", ");
}
