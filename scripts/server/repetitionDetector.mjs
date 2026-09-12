export const DEFAULT_LOOP_REPETITION_COUNT = 5;
export const DEFAULT_MINIMUM_LOOP_PATTERN_WORDS = 24;
export const DEFAULT_MAXIMUM_LOOP_PATTERN_WORDS = 4096;
export const DEFAULT_MINIMUM_LOOP_PATTERN_CHARACTERS = 16;
export const DEFAULT_MAXIMUM_LOOP_PATTERN_CHARACTERS = 16384;
export const DEFAULT_REPETITION_PENALTY = 1;
// A shorter cycle can still be a loop, but only once it has repeated enough
// times to match the same total-matched-word budget as the classic 24-word/
// 5-repetition case (24 * 5 = 120 words); this is what lets a nine-word
// sentence repeated a dozen-plus times get flagged even though it never
// reaches the 24-word single-cycle length on its own.
const MINIMUM_LOOP_UNIT_WORDS = 4;
const TOKEN_LIMIT_MINIMUM_THINKING_WORDS = 3000;
const TOKEN_LIMIT_PATTERN_WORDS = 8;
const TOKEN_LIMIT_MAXIMUM_OUTPUT_CHARACTERS = 32;
export const LOOP_DETECTOR_VERSION = "6";
export const LOOP_DETECTION_CONFIG = Object.freeze({
  version: LOOP_DETECTOR_VERSION,
  repetitionCount: DEFAULT_LOOP_REPETITION_COUNT,
  minimumPatternWords: DEFAULT_MINIMUM_LOOP_PATTERN_WORDS,
  maximumPatternWords: DEFAULT_MAXIMUM_LOOP_PATTERN_WORDS,
  minimumPatternCharacters: DEFAULT_MINIMUM_LOOP_PATTERN_CHARACTERS,
  maximumPatternCharacters: DEFAULT_MAXIMUM_LOOP_PATTERN_CHARACTERS,
  tokenLimitMinimumThinkingWords: TOKEN_LIMIT_MINIMUM_THINKING_WORDS,
  tokenLimitPatternWords: TOKEN_LIMIT_PATTERN_WORDS,
  tokenLimitMaximumOutputCharacters: TOKEN_LIMIT_MAXIMUM_OUTPUT_CHARACTERS
});

const REPETITION_PENALTY_INCREASE_MULTIPLIER = 1.1;
const REPETITION_PENALTY_DECREASE_MULTIPLIER = 0.95;
const REPETITION_PENALTY_SCALE = 100;

function penaltyHundredths(value) {
  return Math.max(1, Math.round((value + Number.EPSILON) * REPETITION_PENALTY_SCALE));
}

function penaltyFromHundredths(value) {
  return value / REPETITION_PENALTY_SCALE;
}

export function initialRepetitionPenalty(configuredValue, extraBody = {}) {
  const explicitPenalty = Number(configuredValue);
  if (Number.isFinite(explicitPenalty) && explicitPenalty > 0) {
    return penaltyFromHundredths(penaltyHundredths(explicitPenalty));
  }
  const configuredPenalty = Number(extraBody.repetition_penalty);
  return Number.isFinite(configuredPenalty) && configuredPenalty > 0
    ? penaltyFromHundredths(penaltyHundredths(configuredPenalty))
    : DEFAULT_REPETITION_PENALTY;
}

export function nextAdaptiveRepetitionPenalty({
  repetitionPenalty,
  knownLoopingPenalty = null,
  testedRepetitionPenalties = [],
  looping
}) {
  const repetitionPenaltyHundredths = penaltyHundredths(repetitionPenalty);
  const testedPenaltyHundredths = new Set([
    repetitionPenaltyHundredths,
    ...testedRepetitionPenalties.map(penaltyHundredths)
  ]);
  if (looping) {
    const knownLoopingPenaltyHundredths = Math.max(
      knownLoopingPenalty === null ? 0 : penaltyHundredths(knownLoopingPenalty),
      repetitionPenaltyHundredths
    );
    let nextPenaltyHundredths = Math.max(
      repetitionPenaltyHundredths + 1,
      penaltyHundredths(repetitionPenalty * REPETITION_PENALTY_INCREASE_MULTIPLIER)
    );
    while (testedPenaltyHundredths.has(nextPenaltyHundredths)) nextPenaltyHundredths += 1;
    return {
      repetitionPenalty: penaltyFromHundredths(nextPenaltyHundredths),
      knownLoopingPenalty: penaltyFromHundredths(knownLoopingPenaltyHundredths)
    };
  }

  const minimumPenaltyHundredths = knownLoopingPenalty === null
    ? 1
    : penaltyHundredths(knownLoopingPenalty) + 1;
  let nextPenaltyHundredths = Math.max(
    minimumPenaltyHundredths,
    Math.min(
      repetitionPenaltyHundredths - 1,
      penaltyHundredths(repetitionPenalty * REPETITION_PENALTY_DECREASE_MULTIPLIER)
    )
  );
  while (
    nextPenaltyHundredths >= minimumPenaltyHundredths
    && testedPenaltyHundredths.has(nextPenaltyHundredths)
  ) {
    nextPenaltyHundredths -= 1;
  }
  if (nextPenaltyHundredths < minimumPenaltyHundredths) {
    nextPenaltyHundredths = minimumPenaltyHundredths;
    while (testedPenaltyHundredths.has(nextPenaltyHundredths)) nextPenaltyHundredths += 1;
  }
  return {
    repetitionPenalty: penaltyFromHundredths(nextPenaltyHundredths),
    knownLoopingPenalty: knownLoopingPenalty === null
      ? null
      : penaltyFromHundredths(penaltyHundredths(knownLoopingPenalty))
  };
}

export function restoreAdaptiveRepetitionPenaltyState(results, configuredValue, extraBody = {}) {
  let state = {
    repetitionPenalty: initialRepetitionPenalty(configuredValue, extraBody),
    knownLoopingPenalty: null
  };
  const testedRepetitionPenalties = [];
  for (const result of results) {
    if (!Number.isFinite(result.repetitionPenalty) || result.modelError) continue;
    testedRepetitionPenalties.push(result.repetitionPenalty);
    state = nextAdaptiveRepetitionPenalty({
      repetitionPenalty: result.repetitionPenalty,
      knownLoopingPenalty: state.knownLoopingPenalty,
      testedRepetitionPenalties,
      looping: Boolean(result.looping)
    });
  }
  return state;
}

function normalizedWordTokens(text) {
  const sourceText = String(text || "");
  const tokens = [...sourceText.toLowerCase().matchAll(/[\p{L}\p{N}_]+/gu)].map((match) => ({
    word: match[0],
    start: match.index,
    end: match.index + match[0].length
  }));
  return tokens.map((token, index) => {
    let sourceEnd = tokens[index + 1]?.start ?? sourceText.length;
    while (sourceEnd > token.end && /\s/u.test(sourceText[sourceEnd - 1])) sourceEnd -= 1;
    return { ...token, sourceEnd };
  });
}

function normalizedCharacterTokens(text) {
  const sourceText = String(text || "");
  const tokens = [...sourceText.matchAll(/\S/gu)].map((match) => ({
    unit: match[0].toLowerCase(),
    start: match.index,
    end: match.index + match[0].length
  }));
  return tokens.map((token, index) => {
    let sourceEnd = tokens[index + 1]?.start ?? sourceText.length;
    while (sourceEnd > token.end && /\s/u.test(sourceText[sourceEnd - 1])) sourceEnd -= 1;
    return { ...token, sourceEnd };
  });
}

function loopDetectionResult(tokens, occurrenceStarts, patternLength, metric, detectionMode) {
  const occurrences = [...occurrenceStarts]
    .sort((left, right) => left - right)
    .map((startWord) => ({
      start: tokens[startWord].start,
      end: tokens[startWord + patternLength - 1].sourceEnd
    }));
  const isCharacterPattern = metric === "characters";
  return {
    detectorVersion: LOOP_DETECTOR_VERSION,
    repetitions: occurrences.length,
    ...(isCharacterPattern
      ? {
          patternCharacters: patternLength,
          matchedCharacters: occurrences.length * patternLength
        }
      : {
          patternWords: patternLength,
          matchedWords: occurrences.length * patternLength
        }),
    excerpt: tokens.slice(occurrenceStarts[0], occurrenceStarts[0] + Math.min(patternLength, 40))
      .map((token) => token.word ?? token.unit)
      .join(isCharacterPattern ? "" : " "),
    occurrences,
    ...(detectionMode ? { detectionMode } : {})
  };
}

function sourceTextForChannel(result, channel) {
  return channel === "output" ? String(result.rawOutput || "") : String(result.thinkingOutput || "");
}

export function reconstructSavedLoopDetection(result) {
  const savedDetection = result?.loopDetection;
  if (
    savedDetection?.detectorVersion === LOOP_DETECTOR_VERSION
    && Array.isArray(savedDetection.occurrences)
    && savedDetection.occurrences.length
  ) return savedDetection;

  const channels = savedDetection?.channel
    ? [savedDetection.channel]
    : ["thinking", "output"];
  for (const channel of channels) {
    const text = sourceTextForChannel(result, channel);
    if (!text) continue;
    const redetected = detectRepetitionLoop(text, savedDetection?.detectionMode === "token-limit"
      ? { minimumPatternWords: TOKEN_LIMIT_PATTERN_WORDS }
      : undefined);
    if (redetected) {
      return {
        ...redetected,
        channel,
        ...(savedDetection?.detectionMode ? { detectionMode: savedDetection.detectionMode } : {})
      };
    }
  }
  return detectTokenLimitRepetitionLoop({
    thinking: result?.thinkingOutput,
    output: result?.rawOutput,
    finishReason: result?.finishReason
  });
}

function unitsMatch(units, leftStart, rightStart, unitCount) {
  for (let unitOffset = 0; unitOffset < unitCount; unitOffset += 1) {
    if (units[leftStart + unitOffset] !== units[rightStart + unitOffset]) return false;
  }
  return true;
}

function alignedOccurrenceStarts(units, finalPatternStart, patternLength, repetitionCount) {
  let repeatedRunStart = finalPatternStart - ((repetitionCount - 1) * patternLength);
  while (
    repeatedRunStart > 0
    && units[repeatedRunStart - 1] === units[repeatedRunStart - 1 + patternLength]
  ) {
    repeatedRunStart -= 1;
  }
  return Array.from(
    { length: Math.floor((units.length - repeatedRunStart) / patternLength) },
    (_, repetitionIndex) => repeatedRunStart + (repetitionIndex * patternLength)
  );
}

function hasShorterPattern(units, start, patternLength, minimumPatternLength) {
  for (let candidateLength = 1; candidateLength < minimumPatternLength; candidateLength += 1) {
    if (patternLength % candidateLength !== 0) continue;
    if (unitsMatch(units, start, start + candidateLength, patternLength - candidateLength)) return true;
  }
  return false;
}

function detectCharacterRepetitionLoop(text, {
  repetitionCount,
  minimumPatternCharacters = DEFAULT_MINIMUM_LOOP_PATTERN_CHARACTERS,
  maximumPatternCharacters = DEFAULT_MAXIMUM_LOOP_PATTERN_CHARACTERS
}) {
  const tokens = normalizedCharacterTokens(text);
  const characters = tokens.map((token) => token.unit);
  const maximumCandidatePatternCharacters = Math.min(
    maximumPatternCharacters,
    Math.floor(characters.length / repetitionCount)
  );
  if (maximumCandidatePatternCharacters < minimumPatternCharacters) return null;

  const punctuationPrefixCounts = [0];
  for (const character of characters) {
    punctuationPrefixCounts.push(
      punctuationPrefixCounts.at(-1) + (/[^\p{L}\p{N}_]/u.test(character) ? 1 : 0)
    );
  }
  const anchorCharacterCount = Math.min(12, minimumPatternCharacters);
  const finalAnchorStart = characters.length - anchorCharacterCount;
  for (
    let patternCharacters = minimumPatternCharacters;
    patternCharacters <= maximumCandidatePatternCharacters;
    patternCharacters += 1
  ) {
    const priorAnchorStart = finalAnchorStart - patternCharacters;
    if (!unitsMatch(characters, priorAnchorStart, finalAnchorStart, anchorCharacterCount)) continue;

    const finalPatternStart = characters.length - patternCharacters;
    const punctuationCount = punctuationPrefixCounts[characters.length]
      - punctuationPrefixCounts[finalPatternStart];
    if (punctuationCount / patternCharacters < 0.5) continue;
    if (hasShorterPattern(
      characters,
      finalPatternStart,
      patternCharacters,
      minimumPatternCharacters
    )) continue;

    let allPatternsMatch = true;
    for (let repetitionIndex = 1; repetitionIndex < repetitionCount; repetitionIndex += 1) {
      const priorPatternStart = finalPatternStart - (repetitionIndex * patternCharacters);
      if (!unitsMatch(characters, priorPatternStart, finalPatternStart, patternCharacters)) {
        allPatternsMatch = false;
        break;
      }
    }
    if (!allPatternsMatch) continue;

    const occurrenceStarts = alignedOccurrenceStarts(
      characters,
      finalPatternStart,
      patternCharacters,
      repetitionCount
    );
    return loopDetectionResult(
      tokens,
      occurrenceStarts,
      patternCharacters,
      "characters"
    );
  }
  return null;
}

export function detectTokenLimitRepetitionLoop({ thinking, output, finishReason }) {
  if (finishReason !== "length") return null;
  if (String(output || "").trim().length > TOKEN_LIMIT_MAXIMUM_OUTPUT_CHARACTERS) return null;
  const tokens = normalizedWordTokens(thinking);
  if (tokens.length < TOKEN_LIMIT_MINIMUM_THINKING_WORDS) return null;
  const detection = detectRepetitionLoop(thinking, {
    minimumPatternWords: TOKEN_LIMIT_PATTERN_WORDS
  });
  return detection ? { channel: "thinking", ...detection, detectionMode: "token-limit" } : null;
}

export function detectRepetitionLoop(text, {
  repetitionCount = DEFAULT_LOOP_REPETITION_COUNT,
  minimumPatternWords = DEFAULT_MINIMUM_LOOP_PATTERN_WORDS,
  maximumPatternWords = DEFAULT_MAXIMUM_LOOP_PATTERN_WORDS
} = {}) {
  const tokens = normalizedWordTokens(text);
  const words = tokens.map((token) => token.word);
  const maximumCandidatePatternWords = Math.min(
    maximumPatternWords,
    Math.floor(words.length / repetitionCount)
  );
  const minimumMatchedWords = minimumPatternWords * repetitionCount;
  const anchorWordCount = Math.min(12, minimumPatternWords);
  const finalAnchorStart = words.length - anchorWordCount;
  for (
    let patternWords = MINIMUM_LOOP_UNIT_WORDS;
    patternWords <= maximumCandidatePatternWords;
    patternWords += 1
  ) {
    const priorAnchorStart = finalAnchorStart - patternWords;
    if (!unitsMatch(words, priorAnchorStart, finalAnchorStart, anchorWordCount)) continue;

    // Cycles shorter than minimumPatternWords only count once they have
    // repeated enough extra times to cover the same total-word budget.
    const requiredRepetitions = Math.max(
      repetitionCount,
      Math.ceil(minimumMatchedWords / patternWords)
    );
    const finalPatternStart = words.length - patternWords;
    let allPatternsMatch = true;
    for (let repetitionIndex = 1; repetitionIndex < requiredRepetitions; repetitionIndex += 1) {
      const priorPatternStart = finalPatternStart - (repetitionIndex * patternWords);
      if (!unitsMatch(words, priorPatternStart, finalPatternStart, patternWords)) {
        allPatternsMatch = false;
        break;
      }
    }
    if (!allPatternsMatch) continue;

    const occurrenceStarts = alignedOccurrenceStarts(
      words,
      finalPatternStart,
      patternWords,
      requiredRepetitions
    );
    return loopDetectionResult(tokens, occurrenceStarts, patternWords, "words");
  }
  return detectCharacterRepetitionLoop(text, {
    repetitionCount,
    maximumPatternCharacters: maximumPatternWords * 4
  });
}