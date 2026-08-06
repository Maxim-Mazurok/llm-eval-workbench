# Benchmark packs

A **benchmark pack** is an optional, self-contained bundle of benchmarks that
the workbench discovers at startup. Packs exist so that benchmarks whose
datasets, prompts or subject matter do not belong in this repository can live
in their own repository — typically added here as a git submodule or cloned in
place — while still plugging into the same runtime, UI and run artifacts.

Packs are entirely optional. With none installed the workbench runs its
built-in benchmarks (HumanEval, BBEH Mini, BBEH Full) alone. A pack directory
that exists but has no server entry point is skipped, so an uninitialised git
submodule (an empty directory) is not an error. A pack that *does* have an
entry point but fails to load is a hard error — a broken pack must be visible,
not silently dropped.

## Layout

```text
packs/<pack-name>/
  pack.server.mjs   server entry point (required)
  pack.client.ts    frontend entry point (optional)
```

Set `BENCHMARK_PACKS_DIR` to load packs from somewhere other than `packs/`.

The two entry points deliberately have distinct basenames: the frontend is
bundled by Vite, whose module resolution would otherwise prefer the `.mjs`
server entry over the `.ts` one.

## Server entry point — `pack.server.mjs`

```js
export const label = "My Pack";          // optional, defaults to the directory name
export const benchmarks = [myBenchmark]; // required
```

Every benchmark in the array must expose a unique string `id` (a collision
with a built-in or another pack throws) and these methods:

| Member                        | Purpose                                                     |
| ----------------------------- | ----------------------------------------------------------- |
| `loadProblems(options)`       | Return the benchmark's problems.                             |
| `problemSummary(problem)`     | Compact problem descriptor for the problems API.             |
| `problemReference(problem)`   | Reference/expected answer used when rendering a task.        |
| `extractArtifact(output, …)`  | Pull the gradeable artifact out of the raw model output.     |
| `evaluate(problem, artifact)` | Score the artifact; return pass/fail plus per-assertion rows. |

Optional members:

| Member                    | Purpose                                                                         |
| ------------------------- | ------------------------------------------------------------------------------- |
| `resolveAssetPath(file)`  | Map a requested asset name to an absolute path, or `null` to refuse it. Enables `GET /api/benchmark-assets/<benchmarkId>/<file>`. Validate the name yourself — the host only checks the file extension against its supported image types. |
| `defaultSystemPrompt`     | The prompt a run uses when the request omits `systemPrompt`. Serve it from the dataset when the dataset owns the prompt, so the prompt has exactly one copy; `GET /api/benchmarks` publishes it and the run form prefers it over the client option. |

## Frontend entry point — `pack.client.ts`

```ts
import type { BenchmarkOption } from "../../src/domain/benchmark";

export const benchmarkOptions: BenchmarkOption[] = [
  {
    id: "my-benchmark",
    // …label, description, default system prompt, prompt template, scoring,
    //   attachesImages, taskIdIndexPattern, …
  }
];
```

The `id` must match a benchmark exported from `pack.server.mjs`. The options
supply everything the UI needs: labels, the default system prompt and prompt
template, whether scoring is binary or graded, whether the benchmark attaches
images, and `taskIdIndexPattern` — the regular expression whose first capture
group turns a task id into its dataset index for task grouping.

`systemPrompt` is optional here. Omit it when the server derives the prompt
from the dataset: the form fills itself from `GET /api/benchmarks`, which
keeps a re-exported dataset from silently disagreeing with a copy checked
into the pack.

## Tests

A pack's own tests are picked up automatically by the `packs/*/**/*.test.*`
entry in `vite.config.ts`, so they run with `npm test` when the pack is
installed and simply do not exist when it is not. Integration tests that need
a live benchmark server can use `createRuntimeTestHarness()` from
`scripts/server/runtimeTestHarness.mjs`.
