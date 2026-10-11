import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import sinon from 'sinon'
import { RtexProcess } from '../../app/src/RtexProcess.mjs'

describe('RtexProcess', () => {
  let child
  let engine
  let spawnProcess
  let signalGroup
  beforeEach(() => {
    child = Object.assign(new EventEmitter(), {
      pid: 100,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    })
    spawnProcess = sinon.stub().returns(child)
    signalGroup = sinon.stub()
    engine = new RtexProcess({
      settings: {
        rtexBinary: '/rtex',
        texDir: '/tex',
        memoryBytes: 123,
        commandTimeoutMs: 1000,
      },
      spawnProcess,
      signalGroup,
    })
    engine.start('/project', 'main.tex')
  })
  afterEach(() => {
    child.emit('exit', 0)
    engine.lines.close()
    vi.useRealTimers()
  })
  it('spawns with argv, RLIMIT_AS and no shell escape', () => {
    const [binary, args, options] = spawnProcess.firstCall.args
    expect(binary).toBe('prlimit')
    expect(args).toEqual([
      '--as=123',
      '--',
      '/rtex',
      'serve',
      '--project',
      '/project',
      '--main',
      'main.tex',
      '--build',
      '/project/build/rtex',
      '--pass-pdf',
      '--binary-dl',
    ])
    expect(options.shell).toBe(false)
    expect(options.env.RTEX_TEXDIR).toBe('/project/build/rtex-support')
    expect(options.env.openin_any).toBe('p')
    expect(options.env.openout_any).toBe('p')
    expect(options.env.shell_escape).toBe('f')
    expect(options.env.TEXMFOUTPUT).toBe('/usr/local/texlive')
    expect(options.env.TEXMF_OUTPUT_DIRECTORY).toBe('/project')
    expect(options.env.TEXMFCACHE).toBe('/project')
  })
  it('correlates serial commands and buffers pre-reply events until attribution callback', async () => {
    const ordered = []
    engine.on('event', () => ordered.push('event'))
    const first = engine.command({ cmd: 'edit' }, () => ordered.push('reply'))
    const second = engine.command({ cmd: 'status' })
    await Promise.resolve()
    expect(engine.pending.command.cmd).toBe('edit')
    child.stdout.write('{"event":"ParagraphUpdate"}\n')
    expect(ordered).toEqual([])
    child.stdout.write('{"reply":"edit","result":{}}\n')
    await first
    await Promise.resolve()
    expect(ordered).toEqual(['reply', 'event'])
    child.stdout.write('{"reply":"status","versions":{}}\n')
    expect((await second).reply).toBe('status')
  })
  it('rejects commands on crash and emits restart information', async () => {
    const crashed = sinon.spy()
    engine.on('crash', crashed)
    const pending = engine.command({ cmd: 'edit' })
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'engine_exited',
    })
    await Promise.resolve()
    child.emit('exit', 1)
    await assertion
    expect(crashed.calledOnce).toBe(true)
  })
  it('rejects engine errors without losing correlation', async () => {
    const pending = engine.command({ cmd: 'edit' })
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'engine_command_failed',
    })
    await Promise.resolve()
    child.stdout.write('{"reply":"error","message":"bad edit"}\n')
    await assertion
    expect(engine.failure).toBeUndefined()
  })
  it('times out, kills the process group and shuts down cleanly', async () => {
    vi.useFakeTimers()
    const pending = engine.command({ cmd: 'status' })
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'engine_timeout',
    })
    await vi.advanceTimersByTimeAsync(1001)
    await assertion
    expect(signalGroup.calledWith(-100, 'SIGKILL')).toBe(true)
    const stopped = engine.stop()
    child.emit('exit', 0)
    await stopped
    expect(vi.getTimerCount()).toBe(0)
  })
})
