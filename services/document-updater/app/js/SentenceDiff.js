// Interleaf: sentence-level diff for agent suggestions.
//
// Upstream's DiffCodec diffs character by character, so a rewritten paragraph
// turns into dozens of tracked changes split inside words. Here the old and new
// text are cut into sentences, the sentences are aligned, and each run of
// changed sentences becomes one tracked delete followed by one tracked insert
// at the same position, which the review panel shows as a single "changed"
// entry. Pure functions only; ReviewApiManager applies the ops.

const DMP = require("diff-match-patch");

const dmp = new DMP();

// Segments are aligned as single characters, so documents are small inputs
dmp.Diff_Timeout = 0.5;

const DIFF_DELETE = -1;
const DIFF_INSERT = 1;
const DIFF_EQUAL = 0;

// One character per distinct segment, kept below the surrogate range so every
// segment is exactly one UTF-16 code unit
const MAX_DISTINCT_SEGMENTS = 0xd000;

const SENTENCE_TERMINATORS = ".?!";
const CJK_TERMINATORS = "。！？";
const CLOSING_CHARACTERS = ")]}\"'’”」』）";

// A period after one of these words does not end the sentence. Matched
// lower-cased against the text right before the period; the lookbehind is
// longer than any of them, so the character before the word is in view.
const ABBREVIATION =
  /[\s([{~](?:e\.g|i\.e|et al|etc|figs?|eqs?|secs?|vs|cf|nos?)$/;
const ABBREVIATION_LOOKBEHIND = 8;

// Lines that are LaTeX structure rather than prose: environment boundaries,
// sectioning commands and comments. Each one is a segment of its own.
const STRUCTURE_LINE =
  /^\s*(?:%|\\(?:begin|end)\s*\{|\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*[[{])/;

/**
 * @typedef {Object} Segment
 * @property {string} text
 * @property {boolean} sentence false for the whitespace between sentences
 */

/**
 * @param {string} character
 */
function isWhitespace(character) {
  return /\s/.test(character);
}

/**
 * @param {string} text
 * @param {number} index
 */
function isEscaped(text, index) {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
}

/**
 * @param {string} text
 * @param {number} periodIndex
 */
function followsAbbreviation(text, periodIndex) {
  const start = Math.max(0, periodIndex - ABBREVIATION_LOOKBEHIND);
  // at the start of the text there is no character before the word
  const boundary = start === 0 ? " " : "";
  return ABBREVIATION.test(
    boundary + text.slice(start, periodIndex).toLowerCase(),
  );
}

/**
 * @param {string} text
 * @param {number} index
 */
function skipClosingCharacters(text, index) {
  let end = index;
  while (end < text.length && CLOSING_CHARACTERS.includes(text[end])) {
    end++;
  }
  return end;
}

/**
 * Where the sentence that has a terminator at `index` ends, or -1 when the
 * character at `index` does not end a sentence.
 *
 * @param {string} text
 * @param {number} index
 * @return {number}
 */
function sentenceEndAt(text, index) {
  const character = text[index];
  if (CJK_TERMINATORS.includes(character)) {
    return skipClosingCharacters(text, index + 1);
  }
  if (!SENTENCE_TERMINATORS.includes(character)) {
    return -1;
  }
  if (isEscaped(text, index)) {
    return -1;
  }
  let end = index + 1;
  while (end < text.length && SENTENCE_TERMINATORS.includes(text[end])) {
    end++;
  }
  end = skipClosingCharacters(text, end);
  if (end < text.length && !isWhitespace(text[end])) {
    return -1;
  }
  if (character === "." && followsAbbreviation(text, index)) {
    return -1;
  }
  return end;
}

/**
 * Split a run of prose lines at sentence ends. The pieces cover the text
 * exactly; whitespace stays at the start of the piece that follows it.
 *
 * @param {string} text
 * @return {string[]}
 */
function splitProse(text) {
  const pieces = [];
  let start = 0;
  let index = 0;
  while (index < text.length) {
    const end = sentenceEndAt(text, index);
    if (end === -1) {
      index++;
      continue;
    }
    pieces.push(text.slice(start, end));
    start = end;
    index = end;
  }
  if (start < text.length) {
    pieces.push(text.slice(start));
  }
  return pieces;
}

/**
 * @param {Segment[]} segments
 * @param {string} text
 */
function pushGap(segments, text) {
  if (text === "") {
    return;
  }
  const last = segments[segments.length - 1];
  if (last != null && !last.sentence) {
    last.text += text;
    return;
  }
  segments.push({ text, sentence: false });
}

/**
 * Add a piece of text as leading whitespace, content and trailing whitespace.
 *
 * @param {Segment[]} segments
 * @param {string} piece
 */
function pushPiece(segments, piece) {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(piece);
  const [, leading, content, trailing] = /** @type {RegExpExecArray} */ (match);
  pushGap(segments, leading);
  if (content !== "") {
    segments.push({ text: content, sentence: true });
  }
  pushGap(segments, trailing);
}

/**
 * Cut text into sentences and the whitespace between them. Blank lines and
 * LaTeX structure lines are hard boundaries; joining the segments gives back
 * the text.
 *
 * @param {string} text
 * @return {Segment[]}
 */
function splitSegments(text) {
  /** @type {Segment[]} */
  const segments = [];
  let prose = "";
  const flushProse = () => {
    for (const piece of splitProse(prose)) {
      pushPiece(segments, piece);
    }
    prose = "";
  };
  for (const line of text.split(/(?<=\n)/)) {
    if (line.trim() === "" || STRUCTURE_LINE.test(line)) {
      flushProse();
      pushPiece(segments, line);
      continue;
    }
    prose += line;
  }
  flushProse();
  return segments;
}

/**
 * Encode both segment lists as strings with one character per distinct
 * segment, the linesToChars trick from diff-match-patch.
 *
 * @param {string[]} oldSegments
 * @param {string[]} newSegments
 * @return {{oldChars: string, newChars: string, segmentArray: string[]} | null}
 */
function segmentsToChars(oldSegments, newSegments) {
  const segmentArray = [];
  const segmentIndex = new Map();
  const encode = (/** @type {string[]} */ segments) => {
    let chars = "";
    for (const segment of segments) {
      let index = segmentIndex.get(segment);
      if (index == null) {
        index = segmentArray.length;
        segmentArray.push(segment);
        segmentIndex.set(segment, index);
      }
      chars += String.fromCharCode(index);
    }
    return chars;
  };
  const oldChars = encode(oldSegments);
  const newChars = encode(newSegments);
  if (segmentArray.length > MAX_DISTINCT_SEGMENTS) {
    return null;
  }
  return { oldChars, newChars, segmentArray };
}

/**
 * @param {string} chars
 * @param {string[]} segmentArray
 */
function charsToText(chars, segmentArray) {
  let text = "";
  for (const char of chars) {
    text += segmentArray[char.charCodeAt(0)];
  }
  return text;
}

/**
 * Align the segments of the two texts. Returns runs of text marked equal,
 * deleted or inserted, in diff-match-patch's tuple format.
 *
 * @param {string} oldText
 * @param {string} newText
 * @return {Array<[number, string]>}
 */
function diffSegments(oldText, newText) {
  const oldSegments = splitSegments(oldText).map((segment) => segment.text);
  const newSegments = splitSegments(newText).map((segment) => segment.text);
  const encoded = segmentsToChars(oldSegments, newSegments);
  if (encoded == null) {
    // Too many distinct sentences to encode: replace the text as one hunk
    return [
      [DIFF_DELETE, oldText],
      [DIFF_INSERT, newText],
    ];
  }
  const { oldChars, newChars, segmentArray } = encoded;
  const diffs = dmp.diff_main(oldChars, newChars, false);
  return diffs.map(([type, chars]) => [type, charsToText(chars, segmentArray)]);
}

/**
 * Length of the common whitespace-only prefix of two strings.
 *
 * @param {string} a
 * @param {string} b
 */
function commonWhitespacePrefix(a, b) {
  let length = 0;
  while (
    length < a.length &&
    length < b.length &&
    a[length] === b[length] &&
    isWhitespace(a[length])
  ) {
    length++;
  }
  return length;
}

/**
 * Length of the common whitespace-only suffix of two strings, not
 * overlapping the first `skip` characters of either.
 *
 * @param {string} a
 * @param {string} b
 * @param {number} skip
 */
function commonWhitespaceSuffix(a, b, skip) {
  let length = 0;
  while (
    length < a.length - skip &&
    length < b.length - skip &&
    a[a.length - 1 - length] === b[b.length - 1 - length] &&
    isWhitespace(a[a.length - 1 - length])
  ) {
    length++;
  }
  return length;
}

/**
 * The ShareJS ops for one changed run: delete the old sentences and insert
 * the new ones at the same position, leaving whitespace both sides share.
 *
 * @param {number} position
 * @param {string} deleted
 * @param {string} inserted
 * @return {{ops: any[], length: number}} ops, and the length of the run in
 *   the new text
 */
function hunkOps(position, deleted, inserted) {
  const prefix = commonWhitespacePrefix(deleted, inserted);
  const suffix = commonWhitespaceSuffix(deleted, inserted, prefix);
  const oldText = deleted.slice(prefix, deleted.length - suffix);
  const newText = inserted.slice(prefix, inserted.length - suffix);
  const ops = [];
  if (oldText !== "") {
    ops.push({ d: oldText, p: position + prefix });
  }
  if (newText !== "") {
    ops.push({ i: newText, p: position + prefix });
  }
  return { ops, length: inserted.length };
}

/**
 * ShareJS text ops that turn `before` into `after` one changed sentence (or
 * run of sentences) at a time. Positions follow ShareJS semantics: each op
 * applies to the document as the previous ops left it.
 *
 * @param {string[]} before
 * @param {string[]} after
 * @return {any[]}
 */
function diffAsShareJsOp(before, after) {
  const oldText = before.join("\n");
  const newText = after.join("\n");
  if (oldText === newText) {
    return [];
  }
  const ops = [];
  let position = 0;
  let deleted = "";
  let inserted = "";
  const flushHunk = () => {
    if (deleted === "" && inserted === "") {
      return;
    }
    const hunk = hunkOps(position, deleted, inserted);
    ops.push(...hunk.ops);
    position += hunk.length;
    deleted = "";
    inserted = "";
  };
  for (const [type, text] of diffSegments(oldText, newText)) {
    if (type === DIFF_DELETE) {
      deleted += text;
    } else if (type === DIFF_INSERT) {
      inserted += text;
    } else if (type === DIFF_EQUAL) {
      flushHunk();
      position += text.length;
    } else {
      throw new Error("Unknown type");
    }
  }
  flushHunk();
  return ops;
}

module.exports = {
  splitSegments,
  diffAsShareJsOp,
};
