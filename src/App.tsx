import { PanelLeftOpen } from "lucide-react";
import { useState } from "react";
import { MetricsPanel } from "./components/MetricsPanel";
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
    selectedRunId,
    selectedRun,
    queueActive,
    selectedScoreRange,
    selectedProgressSegments,
    selectedThinkingStats,
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
    currentTimeMilliseconds,
    setBenchmark,
    setProviderId,
    setModel,
    setMaxOutputTokens,
    setThinkingEnabled,
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
    toggleNotificationsForRun,
    selectRun,
    selectNewBench,
    startRun,
    cancelRun,
    cancelStopping,
    resumeRun,
    deleteRun,
    removeRunFromQueue,
    copyNumbers,
    copyThinkingNumbers,
    saveProvider,
    deleteProvider,
  } = useBenchmarkController();
  const {
    models: availableModels,
    modelTypes: availableModelTypes,
    loading: availableModelsLoading,
    refresh: refreshAvailableModels
  } = useAvailableModels(providerId);

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
          selectedRunId={selectedRunId}
          onSelectNew={selectNewBench}
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
          commentSignalThreshold={commentSignalThreshold}
          selectedLiveEstimate={selectedLiveEstimate}
          selectedPassTiming={selectedPassTiming}
          selectedSpeedStats={selectedSpeedStats}
          selectedRunNotificationsEnabled={selectedRunNotificationsEnabled}
          setCommentSignalThreshold={setCommentSignalThreshold}
          onCopyNumbers={copyNumbers}
          onCopyThinkingNumbers={copyThinkingNumbers}
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
