// Use the real compiler options, but check diagnostics only for touched TS sources.
// Imports are resolved normally. Run with --max-old-space-size=1400 on small hosts.
import ts from 'typescript'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const config = ts.readConfigFile(
  path.join(root, 'tsconfig.json'),
  ts.sys.readFile
)
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
const sources = [
  'modules/live-preview/frontend/js/live-preview-provider.tsx',
  'modules/live-preview/frontend/js/live-preview-overlay.tsx',
  'modules/live-preview/frontend/js/compile-dropdown-item.tsx',
  'modules/live-preview/frontend/js/source-editor-extension.ts',
  'modules/live-preview/frontend/js/live-preview-logs.tsx',
  'modules/live-preview/frontend/js/user-color.ts',
  'modules/live-preview/test/frontend/js/editor.test.ts',
  'modules/live-preview/test/frontend/js/logs.test.tsx',
  'modules/live-preview/test/frontend/js/provider.test.tsx',
]
const files = sources.map(file => path.join(root, file))
const ambient = [
  'types/globals.d.ts',
  'types/assets.d.ts',
  'types/window.ts',
].map(file => path.join(root, file))
const program = ts.createProgram([...files, ...ambient], parsed.options)
const diagnostics = [...program.getOptionsDiagnostics()]
for (const file of files) {
  const source = program.getSourceFile(file)
  diagnostics.push(
    ...program.getSyntacticDiagnostics(source),
    ...program.getSemanticDiagnostics(source)
  )
}
if (diagnostics.length) {
  process.stdout.write(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: file => file,
      getCurrentDirectory: () => root,
      getNewLine: () => '\n',
    })
  )
}
process.stdout.write(
  `Touched-file TypeScript: ${files.length} files, ${diagnostics.length} diagnostics\n`
)
process.exitCode = diagnostics.length ? 1 : 0
