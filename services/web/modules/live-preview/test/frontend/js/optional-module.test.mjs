import { expect } from 'chai'
import { transformFileSync } from '@babel/core'
import { fileURLToPath } from 'node:url'
import Settings from '@overleaf/settings'

describe('optional live-preview frontend integration', function () {
  it('compiles upstream editor and dropdown with empty module slots', function () {
    const saved = Settings.overleafModuleImports
    Settings.overleafModuleImports = Object.fromEntries(
      Object.keys(saved).map(key => [key, []])
    )
    try {
      for (const source of [
        'features/ide-react/editor/share-js-doc.ts',
        'features/pdf-preview/components/pdf-compile-button.tsx',
      ]) {
        const file = fileURLToPath(
          new URL(`../../../../../frontend/js/${source}`, import.meta.url)
        )
        const { code } = transformFileSync(file)
        expect(code).not.to.include('@modules/live-preview')
        expect(code).not.to.include('modules/live-preview')
        expect(code).not.to.include('importOverleafModules')
        if (source.endsWith('pdf-compile-button.tsx')) {
          expect(code).to.match(/compileDropdownItems\s*=\s*\[\]/)
        }
      }
    } finally {
      Settings.overleafModuleImports = saved
    }
  })
})
