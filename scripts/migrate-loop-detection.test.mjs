// @vitest-environment node
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { migrateLoopDetectionMetadata } from "./migrate-loop-detection.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

describe("loop detection metadata migration", () => {
  it("retains strict loops and clears non-contiguous legacy loops once", async () => {
    const runsDirectory = await fs.mkdtemp(join(tmpdir(), "loop-detection-migration-test-"));
    temporaryDirectories.push(runsDirectory);
    const runDirectory = join(runsDirectory, "saved-bbeh-run");
    const backupDirectory = join(runsDirectory, "backups");
    await fs.mkdir(runDirectory);
    await fs.writeFile(join(runDirectory, "run.json"), JSON.stringify({
      id: "bbeh-run-1",
      benchmark: "bbeh-mini",
      model: "demo-model"
    }));

    const streamCycle = Array.from({ length: 24 }, (_, index) => `word${index}`).join(" ");
    const tokenLimitPhrase = "all three witnesses tell the truth or all";
    const originalResults = [
      {
        taskId: "bbeh_mini/0",
        index: 0,
        looping: true,
        thinkingOutput: `${streamCycle}. `.repeat(5),
        rawOutput: "",
        loopDetection: {
          channel: "thinking",
          repetitions: 5,
          patternWords: 24,
          matchedWords: 120,
          excerpt: streamCycle
        }
      },
      {
        taskId: "bbeh_mini/1",
        index: 1,
        looping: true,
        thinkingOutput: Array.from(
          { length: 5 },
          (_, index) => `Analysis ${index}. ${tokenLimitPhrase}. Conclusion ${index}.`
        ).join(" "),
        rawOutput: " ",
        loopDetection: {
          repetitions: 5,
          patternWords: 8,
          matchedWords: 40,
          excerpt: tokenLimitPhrase,
          detectionMode: "token-limit"
        }
      },
      {
        taskId: "bbeh_mini/2",
        index: 2,
        passed: false,
        tests: [{ source: "answer matches", passed: false }],
        thinkingOutput: `${streamCycle}. `.repeat(5),
        rawOutput: "incorrect answer",
        finishReason: "length"
      }
    ];
    await fs.writeFile(join(runDirectory, "results.json"), JSON.stringify(originalResults));

    const preview = await migrateLoopDetectionMetadata({ runsDirectory });
    expect(preview.totals).toMatchObject({
      changedRuns: 1,
      changedResults: 3,
      retainedResults: 1,
      detectedResults: 1,
      clearedResults: 1
    });
    expect(JSON.parse(await fs.readFile(join(runDirectory, "results.json"), "utf8"))).toEqual(originalResults);

    const applied = await migrateLoopDetectionMetadata({
      runsDirectory,
      backupDirectory,
      apply: true,
      now: () => new Date("2026-07-31T00:00:00.000Z")
    });
    expect(applied.backupDirectory).toBe(backupDirectory);
    const updatedResults = JSON.parse(await fs.readFile(join(runDirectory, "results.json"), "utf8"));
    expect(updatedResults[0].loopDetection).toMatchObject({
      channel: "thinking",
      detectorVersion: "5"
    });
    expect(updatedResults[0].loopDetection.occurrences).toHaveLength(5);
    expect(updatedResults[1]).toMatchObject({
      modelError: "Legacy non-contiguous loop classification removed; retry this task to generate a complete result.",
      finishReason: null
    });
    expect(updatedResults[1]).not.toHaveProperty("looping");
    expect(updatedResults[1]).not.toHaveProperty("loopDetection");
    expect(updatedResults[2]).toMatchObject({
      passed: false,
      looping: true,
      finishReason: "length",
      loopDetection: {
        channel: "thinking",
        detectorVersion: "5"
      }
    });
    expect(updatedResults[2].tests).toEqual([{ source: "answer matches", passed: false }]);
    expect(JSON.parse(await fs.readFile(
      join(backupDirectory, "saved-bbeh-run", "results.json"),
      "utf8"
    ))).toEqual(originalResults);

    const secondPass = await migrateLoopDetectionMetadata({ runsDirectory, apply: true });
    expect(secondPass.totals).toMatchObject({
      changedRuns: 0,
      changedResults: 0,
      retainedResults: 0,
      detectedResults: 0,
      clearedResults: 0
    });
  });
});