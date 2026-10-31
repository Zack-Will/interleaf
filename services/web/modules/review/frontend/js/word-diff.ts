import { diffArrays } from 'diff'

export type DiffPart = {
  text: string
  changed: boolean
}

export type WordDiff = {
  removed: DiffPart[]
  added: DiffPart[]
}

// Single CJK characters (those scripts do not separate words with spaces),
// words, runs of whitespace, and any other single character
const TOKEN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}_]+|\s+|[\s\S]/gu

export function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? []
}

function pushPart(parts: DiffPart[], text: string, changed: boolean) {
  const last = parts[parts.length - 1]
  if (last != null && last.changed === changed) {
    last.text += text
    return
  }
  parts.push({ text, changed })
}

function isChanged(part: DiffPart | undefined) {
  return part != null && part.changed
}

/**
 * Highlight the spaces between two changed words too, so that a changed
 * phrase reads as one highlight rather than a row of separate words.
 */
function joinChangedRuns(parts: DiffPart[]): DiffPart[] {
  const joined: DiffPart[] = []
  parts.forEach((part, index) => {
    const between =
      !part.changed &&
      /^\s+$/.test(part.text) &&
      isChanged(parts[index - 1]) &&
      isChanged(parts[index + 1])
    pushPart(joined, part.text, part.changed || between)
  })
  return joined
}

/**
 * Word-level differences between the old and the new text of a suggestion.
 * Each side is cut into parts that are either shared with the other side or
 * changed; joining a side's parts gives back its text.
 */
export function wordDiff(oldText: string, newText: string): WordDiff {
  const removed: DiffPart[] = []
  const added: DiffPart[] = []
  for (const change of diffArrays(tokenize(oldText), tokenize(newText))) {
    const text = change.value.join('')
    if (change.removed) {
      pushPart(removed, text, true)
    } else if (change.added) {
      pushPart(added, text, true)
    } else {
      pushPart(removed, text, false)
      pushPart(added, text, false)
    }
  }
  return { removed: joinChangedRuns(removed), added: joinChangedRuns(added) }
}

/**
 * The first `limit` characters of a side, and whether anything was cut.
 */
export function truncateParts(
  parts: DiffPart[],
  limit: number
): { parts: DiffPart[]; truncated: boolean } {
  const kept: DiffPart[] = []
  let remaining = limit
  for (const part of parts) {
    if (remaining <= 0) {
      return { parts: kept, truncated: true }
    }
    if (part.text.length > remaining) {
      kept.push({ ...part, text: part.text.slice(0, remaining) })
      return { parts: kept, truncated: true }
    }
    kept.push(part)
    remaining -= part.text.length
  }
  return { parts: kept, truncated: false }
}
