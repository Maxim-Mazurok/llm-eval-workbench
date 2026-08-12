import { packBenchmarkOptions } from "./benchmarkPacks";

export function benchmarkApiOrigin(
  pageUrl = window.location.href,
  configuredApiUrl: string | undefined = import.meta.env?.VITE_BENCH_API_URL
) {
  // An explicitly configured API URL wins (Playwright starts the benchmark
  // server on an ephemeral port); otherwise the server is assumed to live on
  // the page's host at its default port.
  if (configuredApiUrl) return new URL(configuredApiUrl).origin;
  const benchmarkApiUrl = new URL(pageUrl);
  benchmarkApiUrl.port = "8787";
  return benchmarkApiUrl.origin;
}

export const BENCH_API = benchmarkApiOrigin();
export const SIDEBAR_COLLAPSED_STORAGE_KEY = "llmEval.sidebar.collapsed";

// Built-in ids are listed for readability; benchmark packs contribute ids this
// repository knows nothing about, so the type stays open.
export type BuiltInBenchmarkId =
  | "humaneval"
  | "bbeh-mini"
  | "bbeh-mini-official"
  | "bbeh-full"
  | "bbeh-full-official";
export type BenchmarkId = BuiltInBenchmarkId | (string & {});
export type BenchmarkKind = "code" | "qa";
// "binary": a task passes or fails. "graded": each task earns a [0,1] score
// and the headline metric is the mean score, not the pass rate.
export type BenchmarkScoring = "binary" | "graded";

export const BBEH_SYSTEM_PROMPT = `You are solving a hard reasoning problem.
Think through the problem step by step before answering.
Keep your reasoning concise and end with your final answer.
`;

export const BBEH_PROMPT_TEMPLATE = `%problem%

When you are done, finish your response with a final line formatted exactly as:
The answer is: <answer>
`;

export type BenchmarkOption = {
  id: BenchmarkId;
  label: string;
  kind: BenchmarkKind;
  scoring?: BenchmarkScoring;
  /** True when every task ships photographs — needs a vision-capable model. */
  attachesImages?: boolean;
  /**
   * Matches task ids whose trailing number is the GLOBAL dataset index, with
   * that number as capture group 1. Omit it when the trailing number means
   * something else (BBEH Full ids end in a subtask-local ordinal), so a still
   * running task sorts last instead of jumping to a wrong position.
   */
  taskIdIndexPattern?: RegExp;
  datasetSize: number;
  /** Omitted when the benchmark's prompt ships with its dataset and the server serves it. */
  systemPrompt?: string;
  promptTemplate: string;
  taskNumbersPlaceholder: string;
  promptTemplateHint: string;
};

export const DEFAULT_SYSTEM_PROMPT = `You are completing a Python programming task.

Implement the requested function exactly as described by the prompt. Prioritize functional correctness above all else. Performance is secondary unless the prompt gives explicit limits.

Use straightforward, readable Python and avoid clever syntax or unnecessary abstractions. Use only the Python standard library. Preserve the required function names, signatures, and return types.

Return only the requested code. Do not include explanations.
`;

export const DEFAULT_PROMPT_TEMPLATE = `Goal:
- Implement the function described by the signature, type hints, docstring, examples, and surrounding context.
- Return Python code that can be executed by a test harness.

Response format:
- Output one markdown multiline code block with python syntax.
- Returning the complete code, including everything required to run: the original signature function, any supporting functions that were already implemented, and any required imports (from standard libraries only).
- Preserve the function name(s), arguments, and return behavior implied by the prompt.

Task prompt:
\`\`\`python
%problem_code%
\`\`\`
`;

export const BENCHMARK_OPTIONS: BenchmarkOption[] = [
  {
    id: "humaneval",
    label: "HumanEval (code)",
    kind: "code",
    taskIdIndexPattern: /^HumanEval\/(\d+)$/i,
    datasetSize: 164,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    promptTemplate: DEFAULT_PROMPT_TEMPLATE,
    taskNumbersPlaceholder: "0, 1, 2 or 10-25. Empty uses start/limit.",
    promptTemplateHint: "Use %problem_code% where the HumanEval function stub should be inserted."
  },
  {
    id: "bbeh-mini",
    label: "BBEH Mini (corrected)",
    kind: "qa",
    taskIdIndexPattern: /^bbeh_mini\/(\d+)$/i,
    datasetSize: 460,
    systemPrompt: BBEH_SYSTEM_PROMPT,
    promptTemplate: BBEH_PROMPT_TEMPLATE,
    taskNumbersPlaceholder: "0, 1, 2 or 10-25. Empty uses start/limit.",
    promptTemplateHint: "Use %problem% where the BBEH task input should be inserted."
  },
  {
    id: "bbeh-mini-official",
    label: "BBEH Mini (official data)",
    kind: "qa",
    taskIdIndexPattern: /^bbeh_mini\/(\d+)$/i,
    datasetSize: 460,
    systemPrompt: BBEH_SYSTEM_PROMPT,
    promptTemplate: BBEH_PROMPT_TEMPLATE,
    taskNumbersPlaceholder: "0, 1, 2 or 10-25. Empty uses start/limit.",
    promptTemplateHint: "Use %problem% where the BBEH task input should be inserted."
  },
  {
    id: "bbeh-full",
    label: "BBEH Full (corrected)",
    kind: "qa",
    datasetSize: 4520,
    systemPrompt: BBEH_SYSTEM_PROMPT,
    promptTemplate: BBEH_PROMPT_TEMPLATE,
    taskNumbersPlaceholder: "0, 1, 2 or 10-25. Empty uses start/limit.",
    promptTemplateHint: "Use %problem% where the BBEH task input should be inserted."
  },
  {
    id: "bbeh-full-official",
    label: "BBEH Full (official data)",
    kind: "qa",
    datasetSize: 4520,
    systemPrompt: BBEH_SYSTEM_PROMPT,
    promptTemplate: BBEH_PROMPT_TEMPLATE,
    taskNumbersPlaceholder: "0, 1, 2 or 10-25. Empty uses start/limit.",
    promptTemplateHint: "Use %problem% where the BBEH task input should be inserted."
  },
  ...packBenchmarkOptions
];

export function benchmarkOption(benchmarkId?: string | null): BenchmarkOption {
  return BENCHMARK_OPTIONS.find((option) => option.id === benchmarkId) ?? BENCHMARK_OPTIONS[0];
}

export function runBenchmarkId(run?: { benchmark?: string; config?: { benchmark?: string } } | null): BenchmarkId {
  return benchmarkOption(run?.config?.benchmark ?? run?.benchmark).id;
}

export function runBenchmarkKind(run?: { benchmark?: string; config?: { benchmark?: string } } | null): BenchmarkKind {
  return benchmarkOption(run?.config?.benchmark ?? run?.benchmark).kind;
}

export function runBenchmarkScoring(run?: { benchmark?: string; config?: { benchmark?: string } } | null): BenchmarkScoring {
  return benchmarkOption(run?.config?.benchmark ?? run?.benchmark).scoring ?? "binary";
}

export const DEFAULT_FORM_VALUES = {
  benchmark: "humaneval" as BenchmarkId,
  providerId: "",
  model: "",
  maxOutputTokens: 2048,
  thinkingEnabled: true,
  thinkingBudget: 8192,
  timeoutSeconds: 15,
  parallelTasks: 1,
  passCount: 1,
  adaptiveRepetitionPenalty: false,
  repetitionPenalty: 1,
  commentSignalThreshold: 50,
  sampleLimit: 0,
  startIndex: 0,
  testNumbers: "",
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  promptTemplate: DEFAULT_PROMPT_TEMPLATE,
  extraBody: "{\n  \"top_p\": 1\n}"
};

export type BenchResult = {
  taskId: string;
  attemptId?: string;
  passNumber?: number;
  passTotal?: number;
  index: number;
  entryPoint: string;
  subtask?: string;
  expectedAnswer?: string;
  /** Photographs that were attached to this task's model call. */
  images?: BenchTaskImage[];
  passed: boolean;
  /** [0,1] confidence-weighted task score; what runs aggregate and display. */
  score?: number;
  /** [0,1] answer quality before confidence weighting; drives pass/partial/fail. */
  answerScore?: number;
  tests: Array<{
    source: string;
    passed: boolean;
    error?: string;
    traceback?: string;
    actual?: string;
    expected?: string;
    operator?: string;
    /** [0,1] component score for graded assertions (age point / range). */
    score?: number;
    /** The model's stated confidence in this answer (0-1). */
    confidence?: number;
  }>;
  instructionPrompt?: string;
  prompt: string;
  test: string;
  rawOutput: string;
  thinkingOutput?: string;
  /** Legacy interleaved thinking+output text; only present on older saved runs. */
  rawTranscript?: string;
  extractedCode: string;
  error?: string | null;
  traceback?: string | null;
  modelError?: string;
  looping?: boolean;
  loopDetection?: {
    detectorVersion?: string;
    channel: string;
    repetitions: number;
    patternWords: number;
    matchedWords: number;
    excerpt: string;
    occurrences?: Array<{
      start: number;
      end: number;
    }>;
    detectionMode?: "token-limit";
  };
  repetitionPenalty?: number;
  generationMs?: number;
  activeDurationMilliseconds?: number;
  evaluationDurationMilliseconds?: number;
  harnessStdout?: string;
  harnessStderr?: string;
  usage?: Record<string, unknown> | null;
};

export type BenchRun = {
  id: string;
  status: string;
  benchmark?: string;
  benchmarkDataRevision?: string | null;
  model: string;
  providerId?: string | null;
  providerName?: string | null;
  baseUrl: string;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  total: number;
  completed: number;
  passed: number;
  failed: number;
  liveScore: number;
  finalScore?: number | null;
  /** Mean of per-task [0,1] scores; equals the pass rate for binary benchmarks. */
  meanScore?: number;
  finalMeanScore?: number | null;
  assertionsPassed: number;
  assertionsTotal: number;
  assertionScore: number;
  currentTaskId: string | null;
  /** When the run entered the waiting line; null once it has never queued. */
  queuedAt?: string | null;
  /** 1-based place in the waiting line while status is "queued"; null otherwise. */
  queuePosition?: number | null;
  logDir?: string;
  selectedIndices?: number[];
  config?: {
    providerId?: string | null;
    providerName?: string | null;
    baseUrl?: string;
    model?: string;
    benchmark?: string;
    apiKey?: string;
    temperature?: number;
    systemPrompt?: string;
    promptTemplate?: string;
    testNumbers?: string;
    maxOutputTokens?: number;
    thinkingEnabled?: boolean;
    thinkingBudget?: number;
    timeoutSeconds?: number;
    parallelTasks?: number;
    passCount?: number;
    adaptiveRepetitionPenalty?: boolean;
    repetitionPenalty?: number;
    sampleLimit?: number;
    startIndex?: number;
    extraBody?: Record<string, unknown>;
  };
  activeTaskIds?: string[];
  activeTaskStartedAt?: Record<string, string>;
  results: BenchResult[];
};

export type TokenEvent = {
  taskId: string;
  attemptId?: string;
  passNumber?: number;
  passTotal?: number;
  index?: number;
  channel: string;
  text: string;
};

export type EventEnvelope = {
  id?: number;
  type: string;
  at: string;
  data: Record<string, unknown>;
};

export type StartedTask = {
  taskId: string;
  attemptId?: string;
  startedAt?: string;
  passNumber: number;
  passTotal: number;
  passOrdinal?: number;
  index: number;
  entryPoint: string;
  subtask?: string;
  prompt?: string;
  test?: string;
  /** Photographs attached to the model call, known from the start event. */
  images?: BenchTaskImage[];
  repetitionPenalty?: number;
};

export type TaskRow = StartedTask & {
  key: string;
  status: "running" | "pass" | "partial" | "fail" | "error" | "loop";
  result?: BenchResult;
};

export type TaskGroup = {
  taskId: string;
  index: number;
  entryPoint: string;
  attempts: TaskRow[];
};

export type PassTabGroup = {
  key: string;
  startPass: number;
  endPass: number;
  status: TaskRow["status"];
  attempts: TaskRow[];
  representative: TaskRow;
};

export type ChartPassGroup = {
  key: string;
  startPass: number;
  endPass: number;
  row: PassVariabilityStats["passRows"][number];
  rows: PassVariabilityStats["passRows"];
  averagePassDurationMilliseconds: number | null;
  completedPassCount: number;
};

export type TaskPromptInfo = {
  prompt?: string;
  instructionPrompt?: string;
  test?: string;
};

/** A photograph attached to a task's model call, served by the bench server. */
export type BenchTaskImage = {
  /** Content-addressed file name (sha256 of the original photo + .jpg). */
  file: string;
  /** When the photograph was posted (YYYY-MM-DD), null when unknown. */
  postedAt: string | null;
  /** Server path (relative to BENCH_API) that returns the jpeg bytes. */
  url: string;
};

export type CommentLineStats = {
  commentLines: number;
  codeLines: number;
  blankLines: number;
  leadingCommentLines: number;
};

export type ThinkingCommentSignal = {
  commentLines: number;
  codeLines: number;
  originalCommentLines: number;
  generatedCommentLines: number;
  generatedCodeLines: number;
  addedCommentLines: number;
  leadingCommentLines: number;
  commentRatio: number;
};

export type PassVariabilityStats = {
  passRows: Array<{
    passNumber: number;
    completed: number;
    passed: number;
    failed: number;
    score: number;
    passDurationMilliseconds: number | null;
    fullyCompleted: boolean;
  }>;
  passTotal: number;
  tasksPerPass: number;
  completedPassCount: number;
  minScore: number;
  maxScore: number;
  spreadPassCount: number;
  taskCounts: {
    total: number;
    allPass: number;
    mixed: number;
    allFail: number;
  };
};

export type BenchRoute = {
  view: "new";
} | {
  view: "run";
  id: string;
};

export function parseBenchRoute(pathname: string): BenchRoute {
  const runMatch = pathname.match(/^\/run\/([^/]+)\/?$/);
  if (runMatch) return { view: "run", id: decodeURIComponent(runMatch[1]) };
  return { view: "new" };
}

export function readBenchRoute(): BenchRoute {
  if (typeof window === "undefined") return { view: "new" };
  return parseBenchRoute(window.location.pathname);
}

export function routePath(route: BenchRoute) {
  return route.view === "run" ? `/run/${encodeURIComponent(route.id)}` : "/new";
}
