<!-- cspell:words OMLX -->

# LLM Eval Workbench

A local web workbench for evaluating LLMs against any OpenAI-compatible
`/v1/chat/completions` endpoint. It runs standard public benchmarks and your own
custom evaluations through the same UI, run engine, and artifact format.

Built-in benchmarks:

- **HumanEval** — code generation, scored by executing the official tests.
- **BBEH Mini / BBEH Full** — [BIG-Bench Extra Hard](https://github.com/google-deepmind/bbeh)
  reasoning tasks, with corrected and official-data variants scored by a
  faithful port of the official `evaluate.py` fuzzy answer matching.

Anything else — additional public benchmarks, private datasets, or bespoke
evaluations — plugs in as an optional **benchmark pack** installed under
`packs/`, with no changes to this repository. See
[`packs/README.md`](packs/README.md).

The core workflow is simple: save a model provider, pick it from the provider
combobox, choose a benchmark, edit the system prompt or user prompt template, start a subset or
full run, and watch live pass/fail results stream in as each task completes.
Each run uses exactly one benchmark.

![LLM Eval Workbench live benchmark workbench](docs/screenshot.png)

## Features

- React/Vite GUI for configuring benchmark runs.
- Saved provider profiles with API keys stored in the operating system's
  credential vault rather than browser storage or benchmark artifacts.
- Benchmark selector: HumanEval (code), corrected/official-data BBEH Mini/Full
  (reasoning), and any benchmarks contributed by installed packs, with
  per-benchmark default prompts and answer extraction.
- OpenAI-compatible streaming chat completions support.
- Editable system prompt and per-benchmark prompt template.
- Per-run thinking toggle, thinking budget, and max output tokens sent to the
  endpoint, so OMLX model settings do not need editing between runs.
- Full runs or targeted task lists such as `0, 1, 2` or `10-25`.
- Configurable pass count for rerunning the selected benchmark set multiple
  times in pass-major order.
- Configurable task parallelism, defaulting to one task at a time.
- Optional streamed loop detection with adaptive per-task repetition penalties.
- Live pass@1 score, completed/passed/failed counts, and assertion-level stats
  (answer checks for BBEH).
- Per-task views for prompt, original task, model output, extracted code or
  final answer, captured reasoning/thinking stream, tests or expected answer,
  traceback, and assertion ledger.
- Copy buttons for failed or passed task numbers so you can rerun focused sets.
- First-class purple `LOOP` results and a copy action for looping task numbers.
- Server-side runs continue if the browser reloads; the UI can reconnect to
  active or historical runs.
- Incomplete stopped, cancelled, interrupted, or errored runs can be resumed
  from their existing saved results.
- Independent per-provider run queues, so remote providers can benchmark
  concurrently while every loopback endpoint shares a protective local lock.

## Quick Start

Requirements:

- Node.js 20 or newer.
- Python 3 available as `python3`.
- A local or remote OpenAI-compatible chat completions endpoint.

Install dependencies:

```bash
npm install
```

Start the web UI and benchmark API server:

```bash
npm run dev
```

The web UI starts after the benchmark API is available. Press `Ctrl+C` to stop
both services. To start only the benchmark API server:

```bash
npm run dev:bench
```

Open:

```text
http://localhost:5173
```

The benchmark server listens on `http://localhost:8787` by default. Override it
with `LLM_EVAL_PORT` if needed:

```bash
LLM_EVAL_PORT=8788 npm run dev:bench
```

## Performance Measurement

The app includes debug-only performance instrumentation for diagnosing browser
memory pressure before changing benchmark behavior. Enable it with
`?debug=performance` in the browser and `LLM_EVAL_PERFORMANCE_LOG=1` on the
benchmark server.

See [docs/performance-measurements.md](docs/performance-measurements.md) for the
measurement workflow, available counters, server log fields, and the intended
evidence-first optimization process.

## Benchmark packs

Benchmarks beyond the built-ins ship as optional **benchmark packs** —
self-contained directories under `packs/` that the workbench discovers at
startup. A pack can live in its own repository (added as a git submodule or
cloned in place), which keeps datasets, prompts and scoring rules that do not
belong in this repository out of it. With no packs installed the workbench
runs the built-in benchmarks alone.

See [`packs/README.md`](packs/README.md) for the pack contract.

### Vision benchmarks

A benchmark may declare that it attaches images to every call. The workbench
then sends the problem's photographs as `image_url` parts alongside the prompt
text, and each task's "Prompt sent to model" panel renders the attached images
above the prompt — results and event logs persist only file names, never image
bytes. The images themselves are streamed from the benchmark's own directory
through `GET /api/benchmark-assets/<benchmarkId>/<file>`, which a benchmark
opts into by implementing `resolveAssetPath(file)`.

**Vision capability detection**: OpenAI-compatible `/v1/models` exposes no
vision flag, and oMLX does NOT reject image parts sent to a text-only model —
it silently drops them and the model answers from text alone, which would
produce garbage scores that look like a completed run. The workbench closes
this hole with oMLX's admin API (`<origin>/admin/api/models`,
`model_type: "vlm" | "llm" | ...`):

- the server **refuses to start or resume** any image-attaching benchmark
  when the chosen model's `model_type` is known and not `"vlm"`, and
- the model combobox tags vision-capable models with a green `vision` badge
  and warns inline when a vision benchmark is paired with a text-only model.

When the admin API is unreachable (non-oMLX endpoints), capability is
unknown and the run is allowed — verify the model can see images yourself.

The Model field is a combobox: suggestions come from the selected provider's
`/v1/models` via the benchmark server's `/api/models` proxy. Opening the
combobox refreshes the list; free text still works when the endpoint is unreachable.

## Providers and API keys

Use `Manage` beside the Provider field to add, edit, or delete connection
profiles. A profile has a display name, an OpenAI-compatible base URL, and an
optional API key. Run forms and model lookups send only the selected provider
ID to the local benchmark server; the server resolves the URL and key.

Provider metadata is written to `.config/providers.json` with owner-only file
permissions and is ignored by git. API keys are stored separately:

- macOS: Login Keychain via the built-in `security` command.
- Windows: Credential Manager via the maintained optional `@github/keytar`
  package.
- Linux: Secret Service via `secret-tool` (`libsecret-tools` on many
  distributions). If a secure keyring is unavailable, saving an API key fails
  explicitly; the app does not fall back to plaintext secret files.

The first launch creates a keyless `Local model server` profile for
`http://localhost:8000/v1`. Edit or delete it like any other provider. Leaving
the API-key field blank while editing keeps an existing saved key; use `Remove
saved API key` to clear it.

To preview mapping older run artifacts to saved providers by exact base URL:

```bash
npm run migrate:providers
```

Use `--apply` to write the mappings. If a provider changed endpoints, add an
explicit alias in the form `--alias=<old-base-url>=<provider-id>`. The migration
also treats an explicit alias as authoritative, so it can correct an earlier
assignment after a more specific provider is saved. The migration
backs up changed `run.json` files beneath
`benchmark-runs/.provider-migration-backups/`; both migrated files and backups
redact any legacy plaintext key.

### Graded scoring

HumanEval and BBEH are binary: a task passes or fails, and the headline number
is the pass rate. A benchmark may instead declare itself **graded**, in which
case each task earns a score in `[0, 1]` and the headline number is the **mean
score**. The per-assertion ledger shows each component score, and a task's
red/amber/green status keys on answer quality alone — a wrong answer that
earns partial score crumbs still reads as a red fail. Graded benchmarks define
their own scoring rules; see the owning pack's documentation.

## Running Benchmarks

Pick a benchmark first. Switching benchmarks loads that benchmark's default
system prompt and prompt template and clears task selections.

Use `Limit = 0` to run the whole dataset (164 HumanEval problems, 460 BBEH Mini
examples, or 4,520 BBEH Full examples). To run a subset, either set `Start` and
`Limit`, or enter explicit `Test numbers` such as:

```text
0, 1, 2
10-25
HumanEval/0 HumanEval/42
```

The prompt template must include `%problem_code%` (HumanEval) or `%problem%`
(BBEH); that marker is replaced with the task input for each problem.

For BBEH, answers are extracted from the model output with the official BBEH
rules (looking for `The answer is: ...` style suffixes, then normalizing), and
scored with the official fuzzy matcher. The default BBEH prompt template asks
the model to finish with `The answer is: <answer>`.

### BBEH data modes

The default `BBEH Mini (corrected)` and `BBEH Full (corrected)` options repair
the seven duplicated Linguini records that the upstream task documentation
identifies as problematic. Their shared ten-blank prompt is narrowed in memory
to the single blank associated with each scalar target. BBEH Mini contains two
of those records: `bbeh_mini/14` and `bbeh_mini/258`.

Use `BBEH Mini (official data)` or `BBEH Full (official data)` when byte-for-byte
upstream prompts are required for leaderboard reproduction. These variants
preserve the problematic multi-blank prompt and its scalar target. Both modes
use the same official fuzzy answer scorer.

Downloaded files under `.cache/bbeh/` always remain unmodified upstream data.
Corrections are source-controlled and applied only to in-memory problem objects.
Each run stores its benchmark data revision; an incomplete run cannot be resumed
after that revision changes because doing so would mix prompts from two dataset
versions.

Set `Parallel` to the number of benchmark tasks to solve at once. The default is
`1`, which preserves sequential execution. Higher values send multiple model
requests concurrently and can make runs faster if your endpoint supports it.

Every run stops a generation after five immediately adjacent repetitions of
the same body of at least 24 normalized words. Punctuation and whitespace may
separate the bodies, but no additional normalized words may appear between
them. A looping task is saved with a `LOOP` classification and exact character
ranges so the UI can mark every loop's start and end in purple.

Enable `Detect loops and adapt repetition penalty` to additionally run tasks
sequentially and adapt the request penalty. Enabling it sets and disables
`Parallel` at `1`. The first task uses the positive `Starting penalty`; there is
no upper limit. After a loop, the next task uses a penalty 10% higher. After a
generation without a detected loop, the next penalty is 5% lower, but never at
or below a penalty already observed looping. Penalties are calculated in
hundredths. If rounding would repeat a tested value or land on the known
looping boundary, the runner selects the nearest untried hundredth above that
boundary. Saved adaptive task results include the penalty, detector version,
and thresholds so interrupted runs resume from reconstructed state. Token-limit
detection uses the same adjacency rule, with a minimum body length of eight
normalized words when long thinking has no usable final output. Model errors
and cancelled attempts do not change the adaptive state.

Set `Passes` to rerun the same selected benchmark set multiple times. The runner
executes the whole task set for pass 1, then the whole task set for pass 2, and
so on. Results are grouped by task in the UI, with pass tabs inside each task
row.

Use `Stop selected` to cancel an active run. If the run is incomplete, select it
again and use `Resume` to continue only the attempts that do not already have
saved results.

Each provider has its own first-in-first-out queue. Azure, OpenAI, and other
remote provider profiles can therefore run at the same time, while runs for the
same provider remain serialized. All loopback endpoints (`localhost`,
`127.0.0.0/8`, `::1`, and `0.0.0.0`) deliberately share one local queue even
when their ports or saved provider profiles differ; this prevents multiple
local model servers from exhausting the same RAM or accelerator.

When the selected provider's lane is busy, `Start run` becomes `Add to queue`
and `Resume` becomes `Queue resume`. The run starts automatically when that
lane becomes free. Each queued run's tab shows its place in its provider line
as a badge; hovering the badge turns the number into an `X` that removes the run
from the queue (on touch screens the `X` appears next to the number on the
selected tab). A run removed from the queue is kept as `cancelled`, so it can be
queued again later or deleted. The queue lives in the benchmark server's memory
and does not survive a server restart.

Timing totals sum active task durations rather than wall time between the run's
start and finish, so stopped or interrupted periods are excluded. New results
include generation and test evaluation time; older saved results use their
recorded generation time. Finish-time estimates apply configured parallelism,
while task-time totals remain the sum of all attempt durations.

`Thinking`, `Thinking budget`, and `Max output tokens` are sent on every
chat-completions request, so reasoning behaviour is configured per run instead
of through the OMLX model settings UI. `Thinking` sends
`chat_template_kwargs.enable_thinking`, `Thinking budget` sends OMLX's
`thinking_budget` (the maximum reasoning tokens before thinking is forcibly
ended), and `max_tokens` is sent as the thinking budget plus the max output
tokens, because OMLX counts reasoning tokens against `max_tokens`. Turning
`Thinking` off sends `enable_thinking: false` with a `thinking_budget` of `0`,
so `max_tokens` equals `Max output tokens`. Properties in `Extra request body`
are merged last and therefore override any of these.

The `Extra request body` field accepts a JSON object and is merged into the
chat completion request. For example:

```json
{
  "top_p": 1,
  "repetition_penalty": 1.05
}
```

OMLX accepts `repetition_penalty` per chat-completions request, so this field
overrides its model or global setting without changing the OMLX UI. Any positive
value is sent as provided; `0`, missing, non-numeric, and negative values are
omitted so OMLX uses its configured default. Adaptive mode uses the dedicated
positive `Starting penalty` field instead of this JSON property.

Runs created before exact loop ranges were recorded can be previewed and then
migrated without re-running benchmark tasks:

```bash
npm run migrate:loop-detection
npm run migrate:loop-detection -- --apply
```

The migration scans every saved result under the current detector, adds newly
detected loops, retains strict legacy loops, and clears non-contiguous legacy
matches as retryable model errors. Applying it backs up each changed
`results.json` beneath `benchmark-runs/.migration-backups/` and is safe to run
again.

## Run Artifacts

Runs are written under `benchmark-runs/<started-at>-<model>-<run-id>/`, with
the timestamp first so folders sort by start time:

- `run.json` contains the run summary and public configuration.
- `results.json` contains task results, extracted code, prompts, harness output,
  model output, usage, and assertion details.
- `task-logs.jsonl` contains aggregate per-task log entries.

`benchmark-runs/` is ignored by git because it can contain private prompts,
model output, endpoint details, and reasoning/thinking traces.

Benchmark datasets are downloaded on demand into `.cache/` (HumanEval as
`HumanEval.jsonl`, BBEH task files under `.cache/bbeh/`), which is also ignored
by git.

### Reprocess saved output

To preview how current output-only extraction changes saved runs without
modifying them:

```bash
npm run reanalyze:output-extraction -- --no-execute
```

To re-extract changed candidates from `rawOutput`, rerun their HumanEval tests,
and update saved run summaries, results, task logs, and events:

```bash
npm run migrate:output-extraction
```

The migration preserves explicit model-request errors, creates timestamped
backups under `benchmark-runs/.migration-backups/`, writes atomically, and is
safe to rerun. Stop the benchmark API server before migrating, then restart it
afterward; an already-running server keeps historical runs in memory and will
not see migrated artifacts until restart.

## Safety

BBEH runs never execute model output; answers are compared as text.

HumanEval evaluates model-generated Python locally. This runner uses temporary
directories, timeouts, and a lightweight reliability guard, but it is not a
hardened sandbox. Run untrusted models or prompts inside a dedicated OS user,
container, VM, or other sandbox.

Do not commit benchmark outputs unless you have reviewed them. They may contain
API endpoint details, model identifiers, prompt text, model completions, and
reasoning/thinking traces.

API keys pass through the local benchmark server only when a provider is saved,
then live in the OS credential vault. Saved runs reference the provider ID and
store `"***"` when a key was present; plaintext keys are never returned by run
APIs or written to `run.json`, `results.json`, browser storage, or queue state.

## Build

```bash
npm run build
```

Preview the production build:

```bash
npm run preview
```

## Disclaimer

This project was vibe coded with Codex GPT-5.5 Medium. Review the code, security
model, and benchmark methodology before relying on results.
