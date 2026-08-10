import { PanelLeftOpen } from "lucide-react";
import { MetricsPanel } from "./components/MetricsPanel";
import { PassVariabilityChart } from "./components/PassVariabilityChart";
import { RunStrip } from "./components/RunStrip";
import { SidebarConfig } from "./components/SidebarConfig";
import { StatusSummary } from "./components/StatusSummary";
import { TaskResults } from "./components/TaskResults";
import { useAvailableModels } from "./hooks/useAvailableModels";
import { useBenchmarkController } from "./hooks/useBenchmarkController";

export default function App() {
  const {
    benchmark,
    baseUrl,
    apiKey,
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
    setBaseUrl,
    setApiKey,
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
    navigateTo,
    selectNewBench,
    startRun,
    cancelRun,
    resumeRun,
    deleteRun,
    removeRunFromQueue,
    copyNumbers,
    copyThinkingNumbers,
  } = useBenchmarkController();
  const {
    models: availableModels,
    modelTypes: availableModelTypes,
    refresh: refreshAvailableModels
  } = useAvailableModels(baseUrl, apiKey);

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
          baseUrl={baseUrl}
          apiKey={apiKey}
          model={model}
          availableModels={availableModels}
          modelTypes={availableModelTypes}
          onRefreshModels={refreshAvailableModels}
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
          onResumeRun={resumeRun}
          setBenchmark={setBenchmark}
          setBaseUrl={setBaseUrl}
          setApiKey={setApiKey}
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
          onNavigate={navigateTo}
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
    </main>
  );
}
