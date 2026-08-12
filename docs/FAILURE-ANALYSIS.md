# Cross-run failure analysis

`scripts/analyze-benchmark-failures.mjs` ranks cases that repeatedly fail across saved
runs and models. It is benchmark-agnostic: benchmark packs own their datasets and
scoring, while the workbench owns run artifacts and cross-run analysis.

```sh
node scripts/analyze-benchmark-failures.mjs \
  --benchmark bbeh-mini --min-models 3 --limit 30
```

The grouping key is `(benchmark, benchmarkDataRevision, taskId)`. Never combine task IDs
across revisions: a pack may regenerate or reorder its dataset. Repeated attempts from
one model are collapsed into one model-level outcome so a heavily repeated run cannot
outvote several independent models.

The report separates semantic failures from model errors, loops, truncation, timeouts,
and evaluation errors. Its labels are review hints:

- `broad-cross-model-failure`: most tested models missed the case;
- `cross-model-split`: models materially disagree;
- `model-specific-failure`: one model family struggles;
- `infrastructure-dominated`: the evidence is mostly invalid executions;
- `expected-answer-conflict`: saved runs disagree about the expected answer at one
  revision and task ID.

None of these labels proves a benchmark defect. Broad failures can be the most valuable
hard cases. Review should distinguish valid difficulty, ambiguous or insufficient input,
bad ground truth, broken scoring, and infrastructure failures before changing a dataset.

Prompts, expected answers, and model outputs are omitted by default because run artifacts
may be sensitive. Use `--json --include-content` only for a local adjudication workflow:

```sh
node scripts/analyze-benchmark-failures.mjs \
  --benchmark my-private-pack --revision revision-id \
  --min-models 2 --limit 10 --json --include-content > /tmp/review-cases.json
```

That JSON can be reviewed manually or sent to a separate local judge model. The generic
workbench should not encode pack-specific rules or commit review payloads; a private pack
can translate a reviewed decision into its own exclusion or correction format.

An OpenAI-compatible judge can also be invoked directly. This is opt-in because it sends
the shortlisted prompts, expected answers, and sample failed outputs to the configured
endpoint. The default endpoint is local oMLX; use only a local or otherwise trusted
endpoint for sensitive run archives.

```sh
node scripts/analyze-benchmark-failures.mjs \
  --benchmark my-private-pack --revision revision-id \
  --min-models 2 --limit 10 --json \
  --judge-model local-model-id
```

The judge uses three generic labels: `model_failure`, `benchmark_issue`, and
`ambiguous_needs_review`. Its verdict is another review signal, not an automatic dataset
mutation. The analyzer strips source content from its output unless `--include-content`
is also supplied; in redacted mode it retains only the judge label and confidence. For a
trusted remote endpoint, set `--judge-base-url` and explicitly name the API-key
environment variable with `--judge-api-key-env`.
