import { describe, expect, it, vi } from 'vitest'
import { createMcpServer } from '../../../index.mjs'

function setup(overrides = {}) {
  const services = {
    ProjectRef: { parse: vi.fn(x => ({ projectId: x.includes('/') ? 'a'.repeat(24) : x })), urlFor: x => `/project/${x}`, requireAccess: vi.fn(async () => {}) },
    SnapshotService: { getFileTree: vi.fn(async () => [{ path: 'main.tex', kind: 'doc' }]), readDoc: vi.fn(async () => ({ path: 'main.tex', lines: ['one', 'two'], totalLines: 2, sha256: 'hash', docVersion: 4 })) },
    VersionService: { getLatestVersion: vi.fn(async () => ({ version: 4 })) },
    LabelService: { listLabels: vi.fn(async () => []) },
    WriteService: { writeFiles: vi.fn(async () => ({ version: 5, applied: [], failed: [] })) },
    ProjectGetter: { promises: { findAllUsersProjects: vi.fn(async () => ({})), getProject: vi.fn(async () => ({ name: 'P' })) } },
    ...overrides,
  }
  const server = createMcpServer({ services, req: { syncUser: { userId: 'u' } } })
  return { server, services }
}

describe('MCP tools', () => {
  it('parses project refs and reads line range', async () => {
    const { server, services } = setup()
    const result = await server._registeredTools.read_file.handler({ project: 'https://x/project/' + 'a'.repeat(24), path: 'main.tex', start_line: 2, end_line: 2 })
    expect(services.ProjectRef.parse).toHaveBeenCalled()
    expect(result.structuredContent.content).toContain('two')
  })
  it('returns permission denial payload', async () => {
    const err = Object.assign(new Error('forbidden'), { code: 'forbidden' })
    const { server } = setup({ ProjectRef: { parse: x => ({ projectId: x }), requireAccess: vi.fn(async () => { throw err }), urlFor: x => x } })
    const result = await server._registeredTools.read_file.handler({ project: 'a'.repeat(24), path: 'main.tex' })
    expect(result.isError).toBe(true); expect(result.structuredContent.code).toBe('forbidden')
  })
  it('returns version conflict payload for writes', async () => {
    const err = Object.assign(new Error('conflict'), { code: 'version_conflict', expectedVersion: 1, actualVersion: 2 })
    const { server } = setup({ WriteService: { writeFiles: vi.fn(async () => { throw err }) } })
    const result = await server._registeredTools.write_files.handler({ project: 'a'.repeat(24), message: 'm', files: [], base_version: 1 })
    expect(result.isError).toBe(true); expect(result.structuredContent.actual_version).toBe(2)
  })
})
