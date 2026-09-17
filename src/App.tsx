import { PanelLeftOpen } from "lucide-react";
import { useState } from "react";
import { MetricsPanel } from "./components/MetricsPanel";
import { BenchmarkComparison } from "./components/BenchmarkComparison";
import { PassVariabilityChart } from "./components/PassVariabilityChart";
import { RunStrip } from "./components/RunStrip";
import { SidebarConfig } from "./components/SidebarConfig";
import { ProviderManager } from "./components/ProviderManager";
import { StatusSummary } from "./components/StatusSummary";
import { TaskResults } from "./components/TaskResults";
import { useAvailableModels } from "./hooks/useAvailableModels";
import { useBenchmarkController } from "./hooks/useBenchmarkController";

export default function App() {
  const [providerManagerOpen, setProviderManagerOpen] = useState(false);
  const {
    benchmark,
    providerId,
    providers,
    providersLoading,
    selectedProvider,
    model,
    maxOutputTokens,
    thinkingEnabled,
    captureTelemetry,
    thinkingBudget,
    timeoutSeconds,
    parallelTasks,
    passCount,
    adaptiveRepetitionPenalty,
    repetitionPenalty,
    sampleLimit,
    startIndex,
    testNumbers,
    systemPrompt,
    promptTemplate,
    extraBody,
    runs,
    route,
    selectedRunId,
    selectedRun,
    queueActive,
    selectedScoreRange,
    selectedProgressSegments,
    selectedThinkingStats,
    selectedBenchmarkMentionStats,
    selectedRunNotificationsEnabled,
    selectedLiveEstimate,
    selectedPassTiming,
    selectedSpeedStats,
    tokensByAttempt,
    promptInfoByAttempt,
    taskGroups,
    error,
    expanded,
    sidebarCollapsed,
    selectedPassByTask,
    commentSignalThreshold,
    benchmarkMentionRegex,
    currentTimeMilliseconds,
    setBenchmark,
    setProviderId,
    setModel,
    setMaxOutputTokens,
    setThinkingEnabled,
    setCaptureTelemetry,
    setThinkingBudget,
    setTimeoutSeconds,
    setParallelTasks,
    setPassCount,
    setAdaptiveRepetitionPenalty,
    setRepetitionPenalty,
    setSampleLimit,
    setStartIndex,
    setTestNumbers,
    setSystemPrompt,
    setPromptTemplate,
    setExtraBody,
    setExpanded,
    setSidebarCollapsed,
    setSelectedPassByTask,
    setCommentSignalThreshold,
    setBenchmarkMentionRegex,
    toggleNotificationsForRun,
    selectRun,
    selectComparison,
    selectComparisonRoute,
    selectNewBench,
    startRun,
    cancelRun,
    cancelStopping,
    resumeRun,
    deleteRun,
    removeRunFromQueue,
    copyNumbers,
    copyThinkingNumbers,
    copyBenchmarkMentionNumbers,
    saveProvider,
    deleteProvider,
  } = useBenchmarkController();
  const {
    models: availableModels,
    modelTypes: availableModelTypes,
    loading: availableModelsLoading,
    refresh: refreshAvailableModels
  } = useAvailableModels(providerId);

  if (route.view === "comparison") {
    return (
      <main className="comparison-shell">
        <BenchmarkComparison
          runs={runs}
          route={route}
          onBack={selectNewBench}
          onRouteChange={selectComparisonRoute}
        />
      </main>
    );
  }

  return (
    <main className={sidebarCollapsed ? "bench-shell sidebar-collapsed" : "bench-shell"}>
      {sidebarCollapsed ? (
        <button
          aria-label="Expand benchmark settings"
          className="sidebar-float-toggle"
          title="Expand settings"
          type="button"
          onClick={() => setSidebarCollapsed(false)}
        >
          <PanelLeftOpen size={21} />
        </button>
      ) : (
        <SidebarConfig
          benchmark={benchmark}
          providerId={providerId}
          providers={providers}
          providersLoading={providersLoading}
          selectedProvider={selectedProvider}
          model={model}
          availableModels={availableModels}
          availableModelsLoading={availableModelsLoading}
          modelTypes={availableModelTypes}
          onRefreshModels={refreshAvailableModels}
          onManageProviders={() => setProviderManagerOpen(true)}
          maxOutputTokens={maxOutputTokens}
          thinkingEnabled={thinkingEnabled}
          captureTelemetry={captureTelemetry}
          thinkingBudget={thinkingBudget}
          timeoutSeconds={timeoutSeconds}
          parallelTasks={parallelTasks}
          passCount={passCount}
          adaptiveRepetitionPenalty={adaptiveRepetitionPenalty}
          repetitionPenalty={repetitionPenalty}
          sampleLimit={sampleLimit}
          startIndex={startIndex}
          testNumbers={testNumbers}
          systemPrompt={systemPrompt}
          promptTemplate={promptTemplate}
          extraBody={extraBody}
          selectedRun={selectedRun}
          queueActive={queueActive}
          error={error}
          onCollapse={() => setSidebarCollapsed(true)}
          onStartRun={startRun}
          onCancelRun={cancelRun}
          onCancelStopping={cancelStopping}
          onResumeRun={resumeRun}
          setBenchmark={setBenchmark}
          setProviderId={setProviderId}
          setModel={setModel}
          setMaxOutputTokens={setMaxOutputTokens}
          setThinkingEnabled={setThinkingEnabled}
          setCaptureTelemetry={setCaptureTelemetry}
          setThinkingBudget={setThinkingBudget}
          setTimeoutSeconds={setTimeoutSeconds}
          setParallelTasks={setParallelTasks}
          setPassCount={setPassCount}
          setAdaptiveRepetitionPenalty={setAdaptiveRepetitionPenalty}
          setRepetitionPenalty={setRepetitionPenalty}
          setSampleLimit={setSampleLimit}
          setStartIndex={setStartIndex}
          setTestNumbers={setTestNumbers}
          setSystemPrompt={setSystemPrompt}
          setPromptTemplate={setPromptTemplate}
          setExtraBody={setExtraBody}
        />
      )}

      <section className="bench-main">
        <RunStrip
          runs={runs}
          route={route}
          selectedRunId={selectedRunId}
          onSelectNew={selectNewBench}
          onSelectComparison={selectComparison}
          onNavigate={selectRun}
          onDelete={deleteRun}
          onRemoveFromQueue={removeRunFromQueue}
        />
        <StatusSummary
          selectedRun={selectedRun}
          selectedScoreRange={selectedScoreRange}
          selectedProgressSegments={selectedProgressSegments}
        />
        <MetricsPanel
          selectedRun={selectedRun}
          selectedThinkingStats={selectedThinkingStats}
          selectedBenchmarkMentionStats={selectedBenchmarkMentionStats}
          commentSignalThreshold={commentSignalThreshold}
          benchmarkMentionRegex={benchmarkMentionRegex}
          selectedLiveEstimate={selectedLiveEstimate}
          selectedPassTiming={selectedPassTiming}
          selectedSpeedStats={selectedSpeedStats}
          selectedRunNotificationsEnabled={selectedRunNotificationsEnabled}
          setCommentSignalThreshold={setCommentSignalThreshold}
          setBenchmarkMentionRegex={setBenchmarkMentionRegex}
          onCopyNumbers={copyNumbers}
          onCopyThinkingNumbers={copyThinkingNumbers}
          onCopyBenchmarkMentionNumbers={copyBenchmarkMentionNumbers}
          onToggleNotifications={toggleNotificationsForRun}
        />
        <PassVariabilityChart run={selectedRun} currentPass={selectedPassTiming} />
        <TaskResults
          taskGroups={taskGroups}
          selectedRun={selectedRun}
          tokensByAttempt={tokensByAttempt}
          promptInfoByAttempt={promptInfoByAttempt}
          expanded={expanded}
          selectedPassByTask={selectedPassByTask}
          commentSignalThreshold={commentSignalThreshold}
          benchmarkMentionRegex={benchmarkMentionRegex}
          currentTimeMilliseconds={currentTimeMilliseconds}
          setExpanded={setExpanded}
          setSelectedPassByTask={setSelectedPassByTask}
        />
      </section>
      <ProviderManager
        open={providerManagerOpen}
        providers={providers}
        selectedProviderId={providerId}
        onClose={() => setProviderManagerOpen(false)}
        onSelect={setProviderId}
        onSave={saveProvider}
        onDelete={deleteProvider}
      />
    </main>
  );
}
