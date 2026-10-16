import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export function findTaskset() {
  return (process.env.PATH || '')
    .split(path.delimiter)
    .map(directory => path.join(directory, 'taskset'))
    .find(file => fs.existsSync(file))
}

export function allowedCpuIds() {
  try {
    const status = fs.readFileSync('/proc/self/status', 'utf8')
    const list = status.match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1]
    if (list) {
      return list.split(',').flatMap(part => {
        const [start, end = start] = part.split('-').map(Number)
        return Array.from(
          { length: end - start + 1 },
          (_, index) => start + index
        )
      })
    }
  } catch {
    // Non-Linux hosts can still run rtex with nice/prlimit.
  }
  return Array.from({ length: os.availableParallelism() }, (_, index) => index)
}
