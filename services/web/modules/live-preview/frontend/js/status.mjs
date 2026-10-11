export function layoutStatusLabel(convergence, compile) {
  const labels = []
  switch (convergence?.state) {
    case 'Converged':
      labels.push('Converged')
      break
    case 'Converging':
      labels.push('Updating…')
      break
    case 'Stale':
      labels.push('Stale')
      break
    case 'PassLimitReached':
      labels.push('Pass limit reached')
      break
  }
  if (
    compile?.state === 'CompiledWithErrors' &&
    Number.isSafeInteger(compile.count) &&
    compile.count >= 0
  ) {
    labels.push(
      `${compile.count} compile ${compile.count === 1 ? 'error' : 'errors'}`
    )
  }
  return labels.join(' · ')
}
