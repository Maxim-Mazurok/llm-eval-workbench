import {
  CircleStop,
  FileText,
  ListPlus,
  PanelLeftClose,
  Play,
  RotateCcw,
  Server,
  Settings2,
  TerminalSquare
} from "lucide-react";
import {
  benchmarkOption,
  type BenchmarkId,
  type BenchRun
} from "../domain/benchmark";
import { normalizeParallelTasks, normalizePassCount, runCanResume, statusIsLive } from "../domain/runs";
import { providerKindLabel, type ProviderConfig } from "../domain/providers";
import { BenchmarkCombobox, ModelCombobox, ProviderCombobox } from "./ModelCombobox";

export type SidebarConfigProps = {
  benchmark: BenchmarkId;
  providerId: string;
  providers: ProviderConfig[];
  providersLoading: boolean;
  selectedProvider: ProviderConfig | null;
  model: string;
  /** Model ids from the endpoint's /v1/models, for the combobox suggestions. */
  availableModels: string[];
  /** True while the selected provider's model list is loading. */
  availableModelsLoading: boolean;
  /** id → oMLX model_type ("vlm" = vision-capable); empty when unknown. */
  modelTypes: Record<string, string>;
  /** Refetches the model list; called whenever the combobox opens. */
  onRefreshModels: () => void;
  onManageProviders: () => void;
  maxOutputTokens: number;
  thinkingEnabled: boolean;
  thinkingBudget: number;
  timeoutSeconds: number;
  parallelTasks: number;
  passCount: number;
  adaptiveRepetitionPenalty: boolean;
  repetitionPenalty: number;
  sampleLimit: number;
  startIndex: number;
  testNumbers: string;
  systemPrompt: string;
  promptTemplate: string;
  extraBody: string;
  selectedRun: BenchRun | null;
  /** True while this provider's lane is live; local providers share one lane. */
  queueActive: boolean;
  error: string | null;
  onCollapse: () => void;
  onStartRun: () => void;
  onCancelRun: () => void;
  onResumeRun: () => void;
  setBenchmark: (value: BenchmarkId) => void;
  setProviderId: (value: string) => void;
  setModel: (value: string) => void;
  setMaxOutputTokens: (value: number) => void;
  setThinkingEnabled: (value: boolean) => void;
  setThinkingBudget: (value: number) => void;
  setTimeoutSeconds: (value: number) => void;
  setParallelTasks: (value: number) => void;
  setPassCount: (value: number) => void;
  setAdaptiveRepetitionPenalty: (value: boolean) => void;
  setRepetitionPenalty: (value: number) => void;
  setSampleLimit: (value: number) => void;
  setStartIndex: (value: number) => void;
  setTestNumbers: (value: string) => void;
  setSystemPrompt: (value: string) => void;
  setPromptTemplate: (value: string) => void;
  setExtraBody: (value: string) => void;
};

export function SidebarConfig(props: SidebarConfigProps) {
  const selectedBenchmark = benchmarkOption(props.benchmark);
  const providerKind = providerKindLabel(props.selectedProvider?.baseUrl);
  return (
    <aside className="bench-sidebar">
      <div className="bench-title-row">
        <div className="bench-title">
          <TerminalSquare size={34} />
          <div>
            <p>{selectedBenchmark.label}</p>
            <h1>LLM benchmark workbench</h1>
          </div>
        </div>
        <button
          aria-label="Collapse benchmark settings"
          className="sidebar-toggle"
          title="Collapse settings"
          type="button"
          onClick={props.onCollapse}
        >
          <PanelLeftClose size={18} />
        </button>
      </div>
      <label className="field checkbox-field">
        <input
          checked={props.adaptiveRepetitionPenalty}
          type="checkbox"
          onChange={(event) => props.setAdaptiveRepetitionPenalty(event.target.checked)}
        />
        <span>Abort loops and adapt repetition penalty</span>
      </label>
      <label className="field">
        <span><FileText size={14} /> Benchmark</span>
        <BenchmarkCombobox
          value={props.benchmark}
          onChange={(benchmark) => {
            if (benchmark) props.setBenchmark(benchmark);
          }}
        />
      </label>
      <div className="provider-field-group">
        <label className="field">
          <span><Server size={14} /> Provider</span>
          <ProviderCombobox
            providers={props.providers}
            value={props.providerId}
            onChange={props.setProviderId}
          />
        </label>
        <button className="manage-providers-button" type="button" onClick={props.onManageProviders}>
          <Settings2 size={15} /> Manage
        </button>
      </div>
      {props.selectedProvider ? (
        <p className="provider-selection-meta">
          <span>{props.selectedProvider.baseUrl}</span>
          <em>{props.selectedProvider.hasApiKey ? "Key secured" : "No key"}</em>
        </p>
      ) : !props.providersLoading ? (
        <button className="provider-empty-action" type="button" onClick={props.onManageProviders}>
          Add a provider before starting a run
        </button>
      ) : null}
      <label className="field">
        <span>Model</span>
        <ModelCombobox
          models={props.availableModels}
          loading={props.availableModelsLoading}
          placeholder="provider/model-name"
          tags={Object.fromEntries(
            props.availableModels.map((modelId) => [
              modelId,
              [
                providerKind?.toLocaleLowerCase(),
                props.modelTypes[modelId] === "vlm" ? "vision" : undefined
              ].filter(Boolean).join(" · ") || undefined
            ])
          )}
          value={props.model}
          onChange={props.setModel}
          onOpen={props.onRefreshModels}
        />
        {providerKind === "Agent" ? (
          <small className="field-warning provider-kind-warning">
            Agent endpoint — Orion adds agent/tool context, so tiny prompts can be billed with substantial input overhead.
            Use a provider tagged “Inference” for ordinary model benchmarks.
          </small>
        ) : null}
        {selectedBenchmark.attachesImages
          && props.modelTypes[props.model.trim()] !== undefined
          && props.modelTypes[props.model.trim()] !== "vlm" ? (
          <small className="field-warning">
            This model is text-only (oMLX model_type "{props.modelTypes[props.model.trim()]}") —
            this benchmark attaches photographs, and the server will refuse the run. Pick a model
            tagged "vision".
          </small>
        ) : null}
      </label>
      <label className="field checkbox-field">
        <input
          checked={props.thinkingEnabled}
          type="checkbox"
          onChange={(event) => props.setThinkingEnabled(event.target.checked)}
        />
        <span>Thinking</span>
      </label>
      <div className="bench-number-grid">
        <label className="field">
          <span>Max output tokens</span>
          <input value={props.maxOutputTokens} min={256} step={256} type="number" onChange={(event) => props.setMaxOutputTokens(Number(event.target.value))} />
        </label>
        <label className="field">
          <span>Thinking budget</span>
          <input disabled={!props.thinkingEnabled} value={props.thinkingBudget} min={0} step={256} type="number" onChange={(event) => props.setThinkingBudget(Number(event.target.value))} />
        </label>
        <label className="field">
          <span>Timeout</span>
          <input value={props.timeoutSeconds} min={1} type="number" onChange={(event) => props.setTimeoutSeconds(Number(event.target.value))} />
        </label>
        <label className="field">
          <span>Parallel</span>
          <input disabled={props.adaptiveRepetitionPenalty} value={props.parallelTasks} min={1} max={64} type="number" onChange={(event) => props.setParallelTasks(normalizeParallelTasks(Number(event.target.value)))} />
        </label>
        <label className="field">
          <span>Passes</span>
          <input value={props.passCount} min={1} max={100} type="number" onChange={(event) => props.setPassCount(normalizePassCount(Number(event.target.value)))} />
        </label>
        <label className="field">
          <span>Starting penalty</span>
          <input disabled={!props.adaptiveRepetitionPenalty} value={props.repetitionPenalty} min={Number.MIN_VALUE} step="any" type="number" onChange={(event) => props.setRepetitionPenalty(Number(event.target.value))} />
        </label>
        <label className="field">
          <span>Start</span>
          <input value={props.startIndex} min={0} max={selectedBenchmark.datasetSize - 1} type="number" onChange={(event) => props.setStartIndex(Number(event.target.value))} />
        </label>
        <label className="field">
          <span>Limit</span>
          <input value={props.sampleLimit} min={0} max={selectedBenchmark.datasetSize} type="number" onChange={(event) => props.setSampleLimit(Number(event.target.value))} />
        </label>
      </div>
      <label className="field">
        <span><FileText size={14} /> Test numbers</span>
        <textarea
          value={props.testNumbers}
          onChange={(event) => props.setTestNumbers(event.target.value)}
          rows={3}
          placeholder={selectedBenchmark.taskNumbersPlaceholder}
        />
      </label>
      <label className="field">
        <span><Settings2 size={14} /> System prompt</span>
        <textarea value={props.systemPrompt} onChange={(event) => props.setSystemPrompt(event.target.value)} rows={5} />
      </label>
      <label className="field">
        <span><FileText size={14} /> Prompt template</span>
        <textarea
          value={props.promptTemplate}
          onChange={(event) => props.setPromptTemplate(event.target.value)}
          rows={11}
          placeholder={selectedBenchmark.promptTemplateHint}
        />
      </label>
      <label className="field">
        <span><Settings2 size={14} /> Extra request body</span>
        <textarea value={props.extraBody} onChange={(event) => props.setExtraBody(event.target.value)} rows={5} />
      </label>
      {selectedBenchmark.kind === "code" ? (
        <div className="bench-warning">
          Executes model-generated Python locally. Use a dedicated sandbox for untrusted endpoints.
        </div>
      ) : null}
      <div className="bench-actions">
        <button
          className="primary-action"
          title={props.queueActive ? "A run is in progress — this run will wait in the queue" : undefined}
          type="button"
          onClick={props.onStartRun}
          disabled={!props.providerId || !props.model.trim()}
        >
          {props.queueActive ? <><ListPlus size={17} /> Add to queue</> : <><Play size={17} /> Start run</>}
        </button>
        <button
          className="secondary-action"
          title={props.queueActive ? "A run is in progress — the resume will wait in the queue" : undefined}
          type="button"
          onClick={props.onResumeRun}
          disabled={!runCanResume(props.selectedRun)}
        >
          {props.queueActive ? <><ListPlus size={17} /> Queue resume</> : <><RotateCcw size={17} /> Resume</>}
        </button>
        <button className="secondary-action" type="button" onClick={props.onCancelRun} disabled={!statusIsLive(props.selectedRun?.status)}>
          <CircleStop size={17} /> Stop selected
        </button>
      </div>
      {props.error ? <p className="bench-error">{props.error}</p> : null}
    </aside>
  );
}
