import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PreviewError } from './Errors.mjs'
import { allowedCpuIds, findTaskset } from './ProcessLimits.mjs'

/** serve has no request ids: at most one command may be on the wire. */
export class RtexProcess extends EventEmitter {
  constructor({
    settings,
    spawnProcess = spawn,
    signalGroup = process.kill,
    taskset = findTaskset(),
    cpuIds = allowedCpuIds(),
  }) {
    super()
    this.settings = settings
    this.spawnProcess = spawnProcess
    this.signalGroup = signalGroup
    this.taskset = taskset
    this.cpuIds = cpuIds
    this.tail = Promise.resolve()
    this.stopping = false
  }

  start(directory, rootDoc) {
    const args = [
      'serve',
      '--project',
      directory,
      '--main',
      rootDoc,
      '--build',
      path.join(directory, 'build/rtex'),
      '--pass-pdf',
      '--binary-dl',
    ]
    let executable = this.settings.rtexBinary
    if (this.settings.memoryBytes > 0) {
      args.unshift(`--as=${this.settings.memoryBytes}`, '--', executable)
      executable = 'prlimit'
    }
    const cpus = this.settings.cpus ?? 2
    if (this.taskset && cpus > 0) {
      const ids = this.cpuIds.slice(0, Math.max(1, Math.floor(cpus)))
      args.unshift('-c', ids.join(','), executable)
      executable = this.taskset
    }
    args.unshift('-n', String(this.settings.nice ?? 10), executable)
    executable = 'nice'
    this.child = this.spawnProcess(executable, args, {
      shell: false,
      detached: true,
      cwd: directory,
      env: {
        ...process.env,
        RTEX_TEXDIR: path.join(directory, 'build/rtex-support'),
        openin_any: 'p',
        openout_any: 'p',
        shell_escape: 'f',
        RTEX_TEXLIVE_BIN: fileURLToPath(
          new URL('../../bin/tex/', import.meta.url)
        ),
        LIVE_PREVIEW_REAL_TEXLIVE_BIN: process.env.RTEX_TEXLIVE_BIN || '',
        // Paranoid kpathsea permits absolute paths under these two roots.
        // luaotfload opens Unicode/font data by absolute path: allow the
        // installed, service-read-only TeX tree and this session, never /etc.
        // Its writable font cache stays inside the disposable session tree.
        TEXMFOUTPUT: this.settings.texmfRoot || '/usr/local/texlive',
        TEXMF_OUTPUT_DIRECTORY: directory,
        TEXMFVAR: directory,
        TEXMFCACHE: directory,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.exited = new Promise(resolve => {
      this.child.once('exit', (code, signal) => {
        this.finish(
          new PreviewError('engine_exited', `rtex exited (${code || signal})`)
        )
        resolve()
        this.killGroup('SIGKILL')
        if (!this.stopping) {
          this.emit('crash', { code, signal })
        }
      })
      this.child.once('error', error => {
        this.finish(new PreviewError('engine_spawn_failed', error.message))
        resolve()
        if (!this.stopping) {
          this.emit('crash', { reason: error.message })
        }
      })
    })
    this.child.stdin.on('error', error =>
      this.finish(new PreviewError('engine_io_failed', error.message))
    )
    this.child.stderr.on('data', bytes => this.emit('stderr', bytes.toString()))
    this.lines = createInterface({ input: this.child.stdout })
    this.lines.on('line', line => this.receive(line))
    return this
  }

  receive(line) {
    try {
      const value = JSON.parse(line)
      if (value.event) {
        if (this.pending) {
          this.pending.events.push(value)
        } else {
          this.emit('event', value)
        }
        return
      }
      const pending = this.pending
      if (
        !pending ||
        (value.reply !== pending.command.cmd && value.reply !== 'error')
      ) {
        throw new PreviewError('engine_protocol_error', 'Unexpected rtex reply')
      }
      clearTimeout(pending.timer)
      this.pending = null
      if (value.reply === 'error') {
        pending.reject(new PreviewError('engine_command_failed', value.message))
      } else {
        // Runs synchronously before buffered paragraph events are released.
        pending.onReply?.(value)
        pending.resolve(value)
      }
      for (const event of pending.events) {
        this.emit('event', event)
      }
    } catch (error) {
      this.finish(error)
      this.killGroup('SIGKILL')
    }
  }

  command(command, onReply) {
    const run = () =>
      new Promise((resolve, reject) => {
        if (this.stopping || this.failure) {
          reject(
            this.failure || new PreviewError('engine_stopped', 'Engine stopped')
          )
          return
        }
        const timer = setTimeout(() => {
          this.finish(
            new PreviewError('engine_timeout', `No reply to ${command.cmd}`)
          )
          this.killGroup('SIGKILL')
        }, this.settings.commandTimeoutMs)
        this.pending = { command, onReply, resolve, reject, timer, events: [] }
        this.child.stdin.write(`${JSON.stringify(command)}\n`)
      })
    const result = this.tail.then(run)
    this.tail = result.catch(() => {})
    return result
  }

  finish(error) {
    this.failure = error
    if (this.pending) {
      clearTimeout(this.pending.timer)
      this.pending.reject(error)
      this.pending = null
    }
  }

  killGroup(signal) {
    if (!this.child?.pid) {
      return
    }
    try {
      this.signalGroup(-this.child.pid, signal)
    } catch (error) {
      if (error.code !== 'ESRCH') {
        this.emit('shutdown-error', error)
      }
    }
  }

  async stop() {
    if (this.stopping) {
      return this.exited
    }
    this.stopping = true
    this.finish(new PreviewError('engine_stopped', 'Engine stopped'))
    this.child?.stdin.end('{"cmd":"quit"}\n')
    const term = setTimeout(() => this.killGroup('SIGTERM'), 1000)
    const kill = setTimeout(() => this.killGroup('SIGKILL'), 3000)
    await this.exited
    clearTimeout(term)
    clearTimeout(kill)
    this.lines?.close()
  }
}
