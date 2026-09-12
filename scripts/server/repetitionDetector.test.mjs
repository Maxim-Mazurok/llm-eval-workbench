import { describe, expect, it } from "vitest";
import {
  detectRepetitionLoop,
  detectTokenLimitRepetitionLoop,
  initialRepetitionPenalty,
  nextAdaptiveRepetitionPenalty,
  reconstructSavedLoopDetection,
  restoreAdaptiveRepetitionPenaltyState
} from "./repetitionDetector.mjs";

// cspell:words OMLX

const repeatedCycle = [
  "Reconsider the choices and compare every condition carefully before selecting the final answer",
  "the first condition supports option alpha while the second condition rules option alpha out",
  "therefore the same unresolved comparison begins again"
].join(". ");

describe("detectRepetitionLoop", () => {
  it("detects five consecutive normalized word cycles", () => {
    const text = Array.from({ length: 5 }, (_, index) => (
      index % 2 ? repeatedCycle.toUpperCase() : repeatedCycle
    )).join("!\n");

    expect(detectRepetitionLoop(text)).toMatchObject({
      repetitions: 5,
      patternWords: 34,
      matchedWords: 170,
      detectorVersion: "6"
    });
    expect(detectRepetitionLoop(text)?.occurrences).toHaveLength(5);
    expect(detectRepetitionLoop(text)?.occurrences[0]).toEqual({
      start: 0,
      end: repeatedCycle.length + 1
    });
  });

  it("does not flag four cycles because models can recover", () => {
    const text = `${repeatedCycle}\n`.repeat(4);

    expect(detectRepetitionLoop(text)).toBeNull();
  });

  it("does not flag repeated short phrases", () => {
    const text = "Wait and reconsider. ".repeat(20);

    expect(detectRepetitionLoop(text)).toBeNull();
  });

  it("flags a sub-24-word cycle once it repeats enough to match the word budget", () => {
    const cycle = "Let's check if \"Culumi\" is a typo for \"Culmi\".";
    const text = `${cycle} `.repeat(13);

    const detection = detectRepetitionLoop(text);
    expect(detection).toMatchObject({ detectorVersion: "6", patternWords: 10 });
    expect(detection.repetitions).toBeGreaterThanOrEqual(12);
  });

  it("still ignores a short phrase that has not repeated enough times to clear the budget", () => {
    const cycle = "Let's check if \"Culumi\" is a typo for \"Culmi\".";
    const text = `${cycle} `.repeat(10);

    expect(detectRepetitionLoop(text)).toBeNull();
  });

  it("does not flag repeated spans separated by changing text", () => {
    const repeatedSpan = "compare the first claimant with the second claimant using every stated constraint before deciding which option remains logically possible";
    const text = Array.from(
      { length: 5 },
      (_, index) => `${repeatedSpan} changing detour number ${index} adds a different observation here`
    ).join(". ");

    expect(detectRepetitionLoop(`${text}. ${repeatedSpan}`)).toBeNull();
  });

  it("does not flag a recovered sequence", () => {
    const text = `${`${repeatedCycle}\n`.repeat(4)}The model resolves the ambiguity and gives a final answer.`;

    expect(detectRepetitionLoop(text)).toBeNull();
  });

  it("detects punctuation-heavy character cycles without enough words", () => {
    const cycle = "actually, it's '()(( ))(( )( ))' ->";
    const text = Array.from({ length: 6 }, () => cycle).join("\n");
    const detection = detectRepetitionLoop(text);

    expect(detection).toMatchObject({
      detectorVersion: "6",
      repetitions: 6,
      patternCharacters: 29,
      matchedCharacters: 174
    });
    expect(detection?.occurrences).toHaveLength(6);
    expect(text.slice(detection.occurrences[0].start, detection.occurrences[0].end))
      .toBe(cycle);
  });

  it("does not inflate a tiny punctuation cycle past the minimum pattern size", () => {
    expect(detectRepetitionLoop("()".repeat(100))).toBeNull();
  });

  it("aligns a partial trailing cycle to the first complete body", () => {
    const repeatedPoints = `Wait, let's look at the points:
      (-10.12, 71.09)
      (-10.52, 74.05)
      (-10.59, 78.17)
      (-11.75, 74.76)
      (-10.64, 66.77)
      (-9.42, 66.06)`;
    const text = `P18: (-8.07, 72.63)\n${Array.from({ length: 6 }, () => repeatedPoints).join("\n")}\nWait, let's look at the`;
    const detection = detectRepetitionLoop(text);

    expect(detection).toMatchObject({
      detectorVersion: "6",
      repetitions: 6,
      patternWords: 31
    });
    expect(text.slice(detection.occurrences[0].start, detection.occurrences[0].end))
      .toBe(repeatedPoints);
    for (let index = 1; index < detection.occurrences.length; index += 1) {
      const priorOccurrence = detection.occurrences[index - 1];
      const occurrence = detection.occurrences[index];
      expect(text.slice(priorOccurrence.end, occurrence.start)).not.toMatch(/[\p{L}\p{N}_]/u);
    }
  });

});

describe("adaptive repetition penalty", () => {
  it("uses the OMLX default or a configured request penalty", () => {
    expect(initialRepetitionPenalty()).toBe(1);
    expect(initialRepetitionPenalty(undefined, { repetition_penalty: 1.08 })).toBe(1.08);
    expect(initialRepetitionPenalty(undefined, { repetition_penalty: 0.9 })).toBe(0.9);
    expect(initialRepetitionPenalty(0.5, { repetition_penalty: 1.08 })).toBe(0.5);
    expect(initialRepetitionPenalty(1.076)).toBe(1.08);
    expect(initialRepetitionPenalty(1.074)).toBe(1.07);
    expect(initialRepetitionPenalty(1000)).toBe(1000);
    expect(initialRepetitionPenalty(0, { repetition_penalty: 0 })).toBe(1);
  });

  it("raises looping penalties by ten percent", () => {
    expect(nextAdaptiveRepetitionPenalty({
      repetitionPenalty: 1,
      knownLoopingPenalty: null,
      looping: true
    })).toEqual({ repetitionPenalty: 1.1, knownLoopingPenalty: 1 });
    expect(nextAdaptiveRepetitionPenalty({
      repetitionPenalty: 1000,
      knownLoopingPenalty: null,
      looping: true
    })).toEqual({ repetitionPenalty: 1100, knownLoopingPenalty: 1000 });
    expect(nextAdaptiveRepetitionPenalty({
      repetitionPenalty: 1,
      knownLoopingPenalty: null,
      testedRepetitionPenalties: [1, 1.1],
      looping: true
    })).toEqual({ repetitionPenalty: 1.11, knownLoopingPenalty: 1 });
  });

  it("lowers clean penalties by five percent without crossing a looping value", () => {
    expect(nextAdaptiveRepetitionPenalty({
      repetitionPenalty: 0.5,
      knownLoopingPenalty: null,
      looping: false
    })).toEqual({ repetitionPenalty: 0.48, knownLoopingPenalty: null });
    expect(nextAdaptiveRepetitionPenalty({
      repetitionPenalty: 1.1,
      knownLoopingPenalty: 1,
      looping: false
    })).toEqual({ repetitionPenalty: 1.05, knownLoopingPenalty: 1 });
    expect(nextAdaptiveRepetitionPenalty({
      repetitionPenalty: 1.01,
      knownLoopingPenalty: 1,
      looping: false
    })).toEqual({ repetitionPenalty: 1.02, knownLoopingPenalty: 1 });
  });

  it("chooses an untried hundredth above the known looping penalty", () => {
    expect(nextAdaptiveRepetitionPenalty({
      repetitionPenalty: 1.08,
      knownLoopingPenalty: 1.05,
      testedRepetitionPenalties: [1.05, 1.08],
      looping: false
    })).toEqual({ repetitionPenalty: 1.06, knownLoopingPenalty: 1.05 });
    expect(nextAdaptiveRepetitionPenalty({
      repetitionPenalty: 1.08,
      knownLoopingPenalty: 1.05,
      testedRepetitionPenalties: [1.05, 1.06, 1.08],
      looping: false
    })).toEqual({ repetitionPenalty: 1.07, knownLoopingPenalty: 1.05 });
    expect(nextAdaptiveRepetitionPenalty({
      repetitionPenalty: 1.07,
      knownLoopingPenalty: 1.05,
      testedRepetitionPenalties: [1.05, 1.06, 1.07, 1.08],
      looping: false
    })).toEqual({ repetitionPenalty: 1.09, knownLoopingPenalty: 1.05 });
  });

  it("restores the next penalty from saved task outcomes", () => {
    expect(restoreAdaptiveRepetitionPenaltyState([
      { repetitionPenalty: 1, looping: true },
      { repetitionPenalty: 1.1, looping: false }
    ], 1)).toEqual({ repetitionPenalty: 1.05, knownLoopingPenalty: 1 });
  });
});

describe("detectTokenLimitRepetitionLoop", () => {
  const repeatedPhrase = "compare every stated condition before selecting the only answer that remains logically possible";
  const longChangingThinking = Array.from(
    { length: 300 },
    (_, index) => `${repeatedPhrase} while observation number ${index} changes the surrounding analysis substantially`
  ).join(". ");
  const longThinkingPrefix = Array.from(
    { length: 3000 },
    (_, index) => `observation${index}`
  ).join(" ");

  it("classifies adjacent repeated bodies with no final output at the token limit", () => {
    expect(detectTokenLimitRepetitionLoop({
      thinking: `${longThinkingPrefix} ${Array.from({ length: 5 }, () => repeatedPhrase).join(" ")}`,
      output: " ",
      finishReason: "length"
    })).toMatchObject({
      channel: "thinking",
      repetitions: 5,
      patternWords: 13,
      detectionMode: "token-limit"
    });
  });

  it("does not classify token-limit phrases separated by changing text", () => {
    expect(detectTokenLimitRepetitionLoop({
      thinking: longChangingThinking,
      output: " ",
      finishReason: "length"
    })).toBeNull();
  });

  it("does not classify a stopped generation or one with a final output", () => {
    expect(detectTokenLimitRepetitionLoop({
      thinking: longChangingThinking,
      output: "",
      finishReason: "stop"
    })).toBeNull();
    expect(detectTokenLimitRepetitionLoop({
      thinking: longChangingThinking,
      output: "The answer is: a sufficiently complete final response",
      finishReason: "length"
    })).toBeNull();
  });
});

describe("reconstructSavedLoopDetection", () => {
  it("reruns canonical detection for a legacy streamed loop", () => {
    const thinkingOutput = `${repeatedCycle}. `.repeat(5);
    const reconstructed = reconstructSavedLoopDetection({
      looping: true,
      thinkingOutput,
      rawOutput: "",
      loopDetection: {
        channel: "thinking",
        repetitions: 5,
        patternWords: 34,
        matchedWords: 170,
        excerpt: repeatedCycle.toLowerCase()
      }
    });

    expect(reconstructed).toMatchObject({
      channel: "thinking",
      detectorVersion: "6",
      repetitions: 5,
      patternWords: 34
    });
    expect(reconstructed?.occurrences).toHaveLength(5);
  });

  it("clears a legacy token-limit signature separated by changing text", () => {
    const repeatedPhrase = "all three witnesses tell the truth or all three witnesses lie";
    const thinkingOutput = Array.from(
      { length: 5 },
      (_, index) => `Changing analysis ${index}. ${repeatedPhrase}. Additional conclusion ${index}.`
    ).join(" ");
    const reconstructed = reconstructSavedLoopDetection({
      looping: true,
      thinkingOutput,
      rawOutput: " ",
      loopDetection: {
        repetitions: 5,
        patternWords: 8,
        matchedWords: 40,
        excerpt: "all three witnesses tell the truth or all",
        detectionMode: "token-limit"
      }
    });

    expect(reconstructed).toBeNull();
  });

  it("rechecks version 2 occurrence ranges instead of trusting them", () => {
    const repeatedSpan = "compare the first claimant with the second claimant using every stated constraint before deciding which option remains logically possible";
    const thinkingOutput = Array.from(
      { length: 5 },
      (_, index) => `${repeatedSpan} changing detour number ${index} adds a different observation here`
    ).join(". ");

    expect(reconstructSavedLoopDetection({
      looping: true,
      thinkingOutput,
      rawOutput: "",
      loopDetection: {
        detectorVersion: "2",
        channel: "thinking",
        repetitions: 5,
        patternWords: 24,
        matchedWords: 120,
        excerpt: repeatedSpan,
        occurrences: Array.from({ length: 5 }, () => ({ start: 0, end: 1 }))
      }
    })).toBeNull();
  });
});