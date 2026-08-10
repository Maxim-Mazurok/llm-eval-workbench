import { useState } from "react";
import {
  benchmarkOption,
  DEFAULT_FORM_VALUES,
  type BenchmarkId,
  type BenchRun
} from "../domain/benchmark";
import {
  formatExtraBody,
  normalizeParallelTasks,
  normalizePassCount
} from "../domain/runs";

/**
 * `systemPromptByBenchmark` comes from the server registry. The field shows an
 * edit when there is one and otherwise tracks that default, so a benchmark whose
 * prompt ships with its dataset picks up a re-exported prompt without the UI
 * carrying its own stale copy.
 */
export function useBenchForm(systemPromptByBenchmark: Record<string, string> = {}) {
  const [benchmark, setBenchmarkState] = useState<BenchmarkId>(DEFAULT_FORM_VALUES.benchmark);
  const [baseUrl, setBaseUrl] = useState(DEFAULT_FORM_VALUES.baseUrl);
  const [apiKey, setApiKey] = useState(DEFAULT_FORM_VALUES.apiKey);
  const [model, setModel] = useState(DEFAULT_FORM_VALUES.model);
  const [maxOutputTokens, setMaxOutputTokens] = useState(DEFAULT_FORM_VALUES.maxOutputTokens);
  const [thinkingEnabled, setThinkingEnabled] = useState(DEFAULT_FORM_VALUES.thinkingEnabled);
  const [thinkingBudget, setThinkingBudget] = useState(DEFAULT_FORM_VALUES.thinkingBudget);
  const [timeoutSeconds, setTimeoutSeconds] = useState(DEFAULT_FORM_VALUES.timeoutSeconds);
  const [parallelTasks, setParallelTasks] = useState(DEFAULT_FORM_VALUES.parallelTasks);
  const [passCount, setPassCount] = useState(DEFAULT_FORM_VALUES.passCount);
  const [adaptiveRepetitionPenalty, setAdaptiveRepetitionPenaltyState] = useState(DEFAULT_FORM_VALUES.adaptiveRepetitionPenalty);
  const [repetitionPenalty, setRepetitionPenalty] = useState(DEFAULT_FORM_VALUES.repetitionPenalty);
  const [commentSignalThreshold, setCommentSignalThreshold] = useState(DEFAULT_FORM_VALUES.commentSignalThreshold);
  const [sampleLimit, setSampleLimit] = useState(DEFAULT_FORM_VALUES.sampleLimit);
  const [startIndex, setStartIndex] = useState(DEFAULT_FORM_VALUES.startIndex);
  const [testNumbers, setTestNumbers] = useState(DEFAULT_FORM_VALUES.testNumbers);
  const [systemPromptEdit, setSystemPromptEdit] = useState<string | null>(null);
  const [promptTemplate, setPromptTemplate] = useState(DEFAULT_FORM_VALUES.promptTemplate);
  const [extraBody, setExtraBody] = useState(DEFAULT_FORM_VALUES.extraBody);

  const systemPrompt =
    systemPromptEdit ?? systemPromptByBenchmark[benchmark] ?? benchmarkOption(benchmark).systemPrompt ?? "";

  // Switching benchmarks swaps in that benchmark's default prompts and clears
  // dataset-specific task selections, which do not transfer between datasets.
  function setBenchmark(nextBenchmark: BenchmarkId) {
    const option = benchmarkOption(nextBenchmark);
    setBenchmarkState(option.id);
    setSystemPromptEdit(null);
    setPromptTemplate(option.promptTemplate);
    setTestNumbers(DEFAULT_FORM_VALUES.testNumbers);
    setStartIndex(DEFAULT_FORM_VALUES.startIndex);
    setSampleLimit(DEFAULT_FORM_VALUES.sampleLimit);
  }

  function resetRunConfig() {
    setBenchmarkState(DEFAULT_FORM_VALUES.benchmark);
    setBaseUrl(DEFAULT_FORM_VALUES.baseUrl);
    setApiKey(DEFAULT_FORM_VALUES.apiKey);
    setModel(DEFAULT_FORM_VALUES.model);
    setMaxOutputTokens(DEFAULT_FORM_VALUES.maxOutputTokens);
    setThinkingEnabled(DEFAULT_FORM_VALUES.thinkingEnabled);
    setThinkingBudget(DEFAULT_FORM_VALUES.thinkingBudget);
    setTimeoutSeconds(DEFAULT_FORM_VALUES.timeoutSeconds);
    setParallelTasks(DEFAULT_FORM_VALUES.parallelTasks);
    setPassCount(DEFAULT_FORM_VALUES.passCount);
    setAdaptiveRepetitionPenaltyState(DEFAULT_FORM_VALUES.adaptiveRepetitionPenalty);
    setRepetitionPenalty(DEFAULT_FORM_VALUES.repetitionPenalty);
    setCommentSignalThreshold(DEFAULT_FORM_VALUES.commentSignalThreshold);
    setSampleLimit(DEFAULT_FORM_VALUES.sampleLimit);
    setStartIndex(DEFAULT_FORM_VALUES.startIndex);
    setTestNumbers(DEFAULT_FORM_VALUES.testNumbers);
    setSystemPromptEdit(null);
    setPromptTemplate(DEFAULT_FORM_VALUES.promptTemplate);
    setExtraBody(DEFAULT_FORM_VALUES.extraBody);
  }

  function loadRunConfig(run: BenchRun) {
    const config = run.config ?? {};
    const option = benchmarkOption(config.benchmark ?? run.benchmark);
    setBenchmarkState(option.id);
    setBaseUrl(config.baseUrl ?? run.baseUrl ?? "");
    // Remote runs only ever get a redacted "***" placeholder back from the
    // server, so re-typing the key is required; local runs persist the real
    // key and can restore it directly.
    setApiKey(config.apiKey && config.apiKey !== "***" ? String(config.apiKey) : DEFAULT_FORM_VALUES.apiKey);
    setModel(config.model ?? run.model ?? "");
    setMaxOutputTokens(Number(config.maxOutputTokens ?? DEFAULT_FORM_VALUES.maxOutputTokens));
    setThinkingEnabled(config.thinkingEnabled ?? DEFAULT_FORM_VALUES.thinkingEnabled);
    setThinkingBudget(Number(config.thinkingBudget ?? DEFAULT_FORM_VALUES.thinkingBudget));
    setTimeoutSeconds(Number(config.timeoutSeconds ?? 15));
    setParallelTasks(normalizeParallelTasks(Number(config.parallelTasks ?? 1)));
    setPassCount(normalizePassCount(Number(config.passCount ?? 1)));
    setAdaptiveRepetitionPenaltyState(Boolean(config.adaptiveRepetitionPenalty));
    setRepetitionPenalty(Number(config.repetitionPenalty ?? config.extraBody?.repetition_penalty ?? 1));
    setSampleLimit(Number(config.sampleLimit ?? 0));
    setStartIndex(Number(config.startIndex ?? 0));
    setTestNumbers(String(config.testNumbers ?? ""));
    setSystemPromptEdit(config.systemPrompt === undefined ? null : String(config.systemPrompt));
    setPromptTemplate(String(config.promptTemplate ?? option.promptTemplate));
    setExtraBody(formatExtraBody(config.extraBody));
  }

  return {
    benchmark, baseUrl, apiKey, model, maxOutputTokens, thinkingEnabled, thinkingBudget, timeoutSeconds, parallelTasks,
    passCount, adaptiveRepetitionPenalty, repetitionPenalty, commentSignalThreshold, sampleLimit, startIndex, testNumbers,
    systemPrompt, promptTemplate, extraBody, setBenchmark, setBaseUrl, setApiKey, setModel,
    setMaxOutputTokens, setThinkingEnabled, setThinkingBudget, setTimeoutSeconds, setParallelTasks, setPassCount,
    setAdaptiveRepetitionPenalty(value: boolean) {
      setAdaptiveRepetitionPenaltyState(value);
      if (value) setParallelTasks(1);
    },
    setRepetitionPenalty,
    setCommentSignalThreshold, setSampleLimit, setStartIndex, setTestNumbers,
    setSystemPrompt: setSystemPromptEdit, setPromptTemplate, setExtraBody, resetRunConfig, loadRunConfig
  };
}
