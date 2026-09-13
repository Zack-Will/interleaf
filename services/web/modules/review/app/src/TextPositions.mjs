// Ranges — comment anchors and tracked changes alike — record a character
// offset into `lines.join('\n')`, the same text document-updater holds.  Agents
// and humans work in line and column numbers, so the translation between them
// belongs in one pure module that both the review services and the MCP tools
// can import without pulling in anything that talks to a database.

/**
 * The 1-based line and column of a character offset.  An offset past the end
 * of the document clamps to the end of the last line.
 *
 * @param {string[]} lines
 * @param {number} position
 * @return {{line: number, column: number}}
 */
export function positionToLineColumn(lines, position) {
  let remaining = Math.max(0, position)
  for (let index = 0; index < lines.length; index += 1) {
    const length = lines[index].length
    if (remaining <= length) return { line: index + 1, column: remaining + 1 }
    remaining -= length + 1
  }
  const lastIndex = Math.max(0, lines.length - 1)
  return {
    line: lines.length || 1,
    column: (lines[lastIndex]?.length ?? 0) + 1,
  }
}

export default { positionToLineColumn }
