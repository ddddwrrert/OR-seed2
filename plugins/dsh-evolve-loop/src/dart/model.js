export const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length
export const median = values => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
export function cvar(values, fraction = 0.2) {
  return mean([...values].sort((a, b) => a - b).slice(0, Math.ceil(values.length * fraction)))
}

export function calibrate(baseline, probes, version) {
  const direction = baseline.metrics.score_direction === 'maximize' ? 1 : -1
  const cases = baseline.metrics.seed_results
  const fullProbes = probes.filter(probe => (probe.metrics.budget_fraction ?? 1) === 1)
  const anchor = cases.map((item, index) => {
    const scores = fullProbes.map(probe => probe.metrics.seed_results[index])
      .filter(entry => entry.judge === 'ACCEPTED').map(entry => direction * entry.score)
    const low = direction * item.score
    const high = Math.max(low, ...scores)
    const scale = Math.max(high - low, Math.abs(low) * 0.05)
    if (!(scale > 0) || !Number.isFinite(scale)) {
      throw new Error(`DART has degenerate anchors for seed ${item.seed}; supply a valid probe with a distinct score`)
    }
    return { seed: item.seed, low, high, scale }
  })
  const model = { version, direction, anchor }
  const rows = probes.map(result => ({ result, vector: normalized(result, model) }))
  const full = rows.filter(({ result }) => (result.metrics.budget_fraction ?? 1) === 1)
  const halfBySource = new Map(rows.filter(({ result }) => result.metrics.budget_fraction === 0.5)
    .map(row => [row.result.source_sha256, row]))
  const grand = full.length ? mean(full.map(row => mean(row.vector))) : 0
  model.cases = anchor.map((item, index) => {
    const values = full.map(row => row.vector[index])
    const difficulty = values.length ? grand - mean(values) : 0
    const spread = values.length ? median(values.map(value => Math.abs(value - median(values)))) : 0
    const accepted = row => row.result.metrics.seed_results[index].judge === 'ACCEPTED'
    const pairs = full.flatMap(row => {
      const half = halfBySource.get(row.result.source_sha256)
      return half ? [{ row, half }] : []
    })
    const gains = pairs.filter(({ row, half }) => accepted(row) && accepted(half))
      .map(({ row, half }) => row.vector[index] - half.vector[index])
    return { seed: item.seed, index, difficulty, spread, observations: rows.length,
      full_observations: full.length,
      full_pass_rate: full.length ? full.filter(accepted).length / full.length : null,
      half_timeouts: pairs.filter(({ half }) => half.result.metrics.seed_results[index].judge === 'TIME_LIMIT_EXCEEDED').length,
      budget_gain: gains.length ? mean(gains) : null, budget_pairs: gains.length }
  })
  return model
}

export function normalized(result, model) {
  return result.metrics.seed_results.map((item, index) => {
    const { low, scale } = model.anchor[index]
    return item.judge === 'ACCEPTED' ? (model.direction * item.score - low) / scale : -2
  })
}

export function decomposition(vector, model) {
  const ability = mean(vector)
  return { ability, interaction: vector.map((value, index) => value - ability + model.cases[index].difficulty) }
}

export function profiles(entries, model, champion) {
  const vectors = entries.map(entry => entry.vector)
  const cases = model.cases.map((item, index) => {
    const values = vectors.map(row => row[index])
    const gap = Math.max(0, ...values) - champion[index]
    const response = entries.map(entry => entry.effects.interaction[index])
    const center = mean(response)
    const magnitude = Math.hypot(...response.map(value => value - center))
    const signature = response.map(value => magnitude ? (value - center) / magnitude : 0)
    return { ...item, index, gap, signature }
  })
  // Deterministic agglomeration using average linkage on interaction signatures.
  const distances = cases.map(a => cases.map(b => {
    const correlationDistance = mean(a.signature.map((value, k) => (value - b.signature[k]) ** 2))
    return correlationDistance + 0.1 * (a.difficulty - b.difficulty) ** 2 + 0.1 * (a.gap - b.gap) ** 2
  }))
  const groups = cases.map(item => [item])
  while (groups.length > Math.ceil(Math.sqrt(cases.length))) {
    let best = [0, 1]
    let distance = Infinity
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const d = mean(groups[i].flatMap(a => groups[j].map(b => distances[a.index][b.index])))
        if (d < distance) {
          distance = d
          best = [i, j]
        }
      }
    }
    groups[best[0]].push(...groups.splice(best[1], 1)[0])
  }
  return { cases: cases.map(({ signature, ...item }) => item), groups: groups.map(group => group.map(item => item.index)) }
}

export function archive(entries, groups, count = 2) {
  return groups.map(group => [...entries].sort((a, b) =>
    mean(group.map(index => b.vector[index])) - mean(group.map(index => a.vector[index]))
  ).slice(0, count).map(entry => entry.id))
}

export function lexicase(entries, cases, random = Math.random) {
  let remaining = entries
  const order = cases.map(item => ({
    ...item,
    priority: -Math.log(Math.max(Number.MIN_VALUE, random())) /
      (1 + Math.max(0, item.difficulty) + Math.max(0, item.gap)),
  })).sort((a, b) => a.priority - b.priority)
  for (const { index } of order) {
    if (remaining.length <= 1) break
    const feasible = remaining.filter(entry => !entry.raw || entry.raw[index].judge === 'ACCEPTED')
    if (!feasible.length) continue
    remaining = feasible
    const scores = remaining.map(entry => entry.vector[index])
    const center = median(scores)
    const epsilon = Math.min(0.25, median(scores.map(value => Math.abs(value - center))))
    const cutoff = Math.max(...scores) - epsilon
    remaining = remaining.filter(entry => entry.vector[index] >= cutoff)
  }
  return remaining[Math.floor(random() * remaining.length)].id
}

export function fixedEasyFloor(cases, baseline, model, tolerance = 0.10) {
  const cutoff = median(model.cases.map(item => item.difficulty))
  return model.cases.every(({ index, difficulty }) => {
    const reference = baseline[index]
    if (difficulty > cutoff || reference.judge !== 'ACCEPTED') return true
    const result = cases[index]
    const loss = model.direction * (reference.score - result.score)
    return result.judge === 'ACCEPTED' && loss <= tolerance * Math.abs(reference.score)
  })
}

export function guarded(vector, incumbent, model, tolerance = 0.10) {
  const medianDifficulty = median(model.cases.map(item => item.difficulty))
  const easy = model.cases.filter(item => item.difficulty <= medianDifficulty)
  if (easy.some(({ index }) => vector[index] < -tolerance)) return false
  const delta = vector.map((value, index) => value - incumbent[index])
  return cvar(vector) >= cvar(incumbent) - 0.02 && cvar(delta) >= -0.15
}

export function utility(vector) {
  return mean(vector) + 0.5 * cvar(vector)
}

