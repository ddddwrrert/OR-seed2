import { acceptedCase, clamp, gain, mean } from './model.js'

const milestones = [0.02, 0.05, 0.1, 0.2]
const qualityGoals = [0.3, 0.5, 0.7, 0.9]

function tokenSet(source) {
  return new Set(source.toLowerCase().match(/[a-z_][a-z_0-9]{2,}/g) ?? [])
}
export function similarity(left, right) {
  const common = [...left.tokens].filter(token => right.tokens.has(token)).length
  return common / (left.tokens.size + right.tokens.size - common || 1)
}
function cosine(left, right) {
  const pairs = left.flatMap((value, index) => value === null || right[index] === null ? [] : [[value, right[index]]])
  const a = Math.hypot(...pairs.map(pair => pair[0]))
  const b = Math.hypot(...pairs.map(pair => pair[1]))
  return a && b ? clamp(pairs.reduce((total, [x, y]) => total + x * y, 0) / (a * b), -1, 1) : 0
}
export function classify(history, events) {
  const families = []
  const byId = new Map()
  const changes = new Map(events.map(event => [event.id, event]))
  for (const entry of history) {
    entry.tokens = tokenSet(entry.code ?? '')
    const parent = byId.get(entry.parent)
    const event = changes.get(entry.id)
    const mechanism = event?.mechanism ?? ''
    const scores = entry.raw.map((record, index) => {
      const reference = history[0].raw[index]
      if (!acceptedCase(record) || !acceptedCase(reference)) return null
      return (record.score - reference.score) / (Math.abs(record.score) + Math.abs(reference.score) || 1)
    })
    const profile = { ...entry, scores, mechanism }
    const same = families.find(item => item.source === entry.source ||
      (similarity(item, profile) >= (parent?.family === item.id ? 0.54 : 0.78) &&
        (!mechanism || !item.mechanism || mechanism === item.mechanism || cosine(item.scores, scores) >= 0.6)))
    if (!same) families.push(profile)
    entry.family = same?.id ?? entry.id
    profile.family = entry.family
    byId.set(entry.id, profile)
  }
  return history
}

export function lineageWeights(history) {
  const unique = [...new Map([...history].reverse().map(entry => [entry.source ?? entry.id, entry])).values()]
  const counts = new Map()
  for (const { family } of unique) counts.set(family, (counts.get(family) ?? 0) + 1)
  return unique.map(({ id, family }) => ({ id, family, weight: 1 / (counts.size * counts.get(family)) }))
}

export function qualityCost(record, bounds, direction) {
  if (!bounds || !acceptedCase(record)) return 1
  const attainment = score => clamp((direction * score - bounds.lower) / (bounds.upper - bounds.lower))
  const trace = record.quality_trace?.filter(point => Number.isFinite(point.score) &&
    Number.isFinite(point.seconds) && point.seconds >= 0 && point.seconds <= bounds.seconds)
  if (!trace?.length) return mean(qualityGoals.map(goal => Number(attainment(record.score) < goal)))
  return mean(qualityGoals.map(goal => Math.min(bounds.seconds, ...trace.filter(point => attainment(point.score) >= goal)
    .map(point => point.seconds)) / bounds.seconds))
}

export function difficultyRegistry(history, weights, model, quality, previous, minSamples = 8, baseline = history[0]) {
  const byId = new Map(history.map(entry => [entry.id, entry]))
  const families = new Set(weights.map(item => item.family)).size
  const frozen = weights.length >= minSamples && families >= 2
  if (previous) {
    const oldFamilies = new Set(previous.cohorts.map(item => item.family))
    const counts = new Map()
    for (const item of weights) {
      if (!oldFamilies.has(item.family)) counts.set(item.family, (counts.get(item.family) ?? 0) + 1)
    }
    // Require independently sourced quality evidence and a reproducible new family.
    if (!quality || ![...counts.values()].some(count => count >= 3)) return previous
  }
  const cases = model.anchor.map((anchor, index) => {
    const bounds = quality?.[anchor.seed]
    const ref = bounds && frozen ? weights.reduce((total, { id, weight }) =>
      total + weight * qualityCost(byId.get(id).raw[index], bounds, model.direction), 0) : null
    const hist = 1 - mean(milestones.map(goal => weights.reduce((total, { id, weight }) => {
      const delta = gain(byId.get(id).raw[index], baseline.raw[index], anchor, model.direction)
      return total + weight * Number(delta !== null && delta >= goal)
    }, 0)))
    return { seed: anchor.seed, reference_difficulty: ref, historical_attainment_difficulty: hist,
      difficulty_status: ref === null ? 'UNKNOWN' : 'CALIBRATED',
      confidence: clamp(weights.length / Math.max(1, minSamples)) * clamp(families / 3) }
  })
  if (previous) {
    const observed = cases.filter((item, index) => item.reference_difficulty !== null && item.confidence >= 0.65 &&
      previous.cases[index].reference_difficulty !== null)
    const changes = observed.filter(item => {
      const old = previous.cases.find(record => record.seed === item.seed)
      return Math.abs(item.reference_difficulty - old.reference_difficulty) >= 0.2
    })
    if (!observed.length || changes.length < Math.ceil(observed.length * 0.2)) return previous
  }
  return { frozen, cohorts: weights, normalizer: model.version, cases }
}

function fitInteraction(matrix, fixed, direction) {
  const columns = matrix[0]?.length ?? 0
  const average = mean(matrix.flatMap(row => row.filter(value => value !== null)))
  const caseBias = Array.from({ length: columns }, (_, index) => fixed?.[index] ??
    (mean(matrix.map(row => row[index]).filter(value => value !== null)) - average))
  const regressors = matrix.map(row => mean(row.flatMap((value, index) =>
    value === null ? [] : [value - average - caseBias[index]])))
  const residuals = matrix.map((row, i) => row.map((value, index) =>
    value === null ? null : value - average - caseBias[index] - regressors[i]))
  let factors = caseBias.map((_, index) => index % 2 ? -0.1 : 0.1)
  let rows = regressors.map(() => 0)
  const ridge = 0.2
  for (let iteration = 0; iteration < 8; iteration++) {
    rows = residuals.map(row => row.reduce((sum, value, index) => sum + (value ?? 0) * factors[index], 0) /
      (ridge + row.reduce((sum, value, index) => sum + (value === null ? 0 : factors[index] ** 2), 0)))
    factors = factors.map((_, index) => residuals.reduce((sum, row, i) => sum + (row[index] ?? 0) * rows[i], 0) /
      (ridge + residuals.reduce((sum, row, i) => sum + (row[index] === null ? 0 : rows[i] ** 2), 0)))
    const center = mean(factors)
    factors = factors.map(value => value - center)
  }
  const center = mean(regressors)
  return regressors.map((value, i) => ({ ability: direction * (value - center),
    instance_effect: caseBias, interaction: factors.map(factor => rows[i] * factor) }))
}

export function decomposition({ entries, model, registry, quality }) {
  const useQuality = registry.frozen && registry.cases.every(item => item.reference_difficulty !== null)
  const matrix = useQuality ? entries.map(entry => entry.raw.map(item =>
    qualityCost(item, quality[item.seed], model.direction))) : entries.map(entry => entry.vector)
  const fixed = useQuality ? registry.cases.map(item => item.reference_difficulty) : undefined
  return fitInteraction(matrix, fixed, useQuality ? -1 : 1)
}

function correlation(pairs) {
  if (pairs.length < 3) return 0
  const a = mean(pairs.map(pair => pair[0]))
  const b = mean(pairs.map(pair => pair[1]))
  const left = pairs.map(pair => pair[0] - a)
  const right = pairs.map(pair => pair[1] - b)
  return cosine(left, right) * pairs.length / (pairs.length + 3)
}

export function clusterResponses(events, size) {
  const recent = [...new Map(events.slice(-100).map(event => [
    `${event.parent_source}/${event.source}`, event
  ])).values()].filter(event => event.delta?.some(value => value !== null))
  const groups = Array.from({ length: size }, (_, index) => [index])
  if (recent.length < 3) return { groups, conflicts: [], correlation: [] }
  const centers = recent.map(event => mean(event.delta.filter(value => value !== null)))
  const raw = groups.map(([i]) => groups.map(([j]) => correlation(recent.flatMap(event =>
    event.delta[i] == null || event.delta[j] == null ? [] : [[event.delta[i], event.delta[j]]]))))
  const centered = groups.map(([i]) => groups.map(([j]) => correlation(recent.flatMap((event, e) =>
    event.delta[i] == null || event.delta[j] == null ? [] :
      [[event.delta[i] - centers[e], event.delta[j] - centers[e]]]))))
  const conflicts = raw.flatMap((row, i) => row.flatMap((value, j) => {
    const controlled = recent.some(event => event.control_status === 'paired' &&
      (event.delta[i] ?? 0) * (event.delta[j] ?? 0) < 0)
    return i < j && value < -0.25 ? [{ left: i, right: j, weight: -value, controlled }] : []
  })).sort((a, b) => b.weight - a.weight)
  while (groups.length > Math.ceil(Math.sqrt(size))) {
    let best = [0, 1]
    let score = -Infinity
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const similarity = mean(groups[i].flatMap(left => groups[j].map(right =>
          (raw[left][right] + centered[left][right]) / 2)))
        if (similarity > score) {
          score = similarity
          best = [i, j]
        }
      }
    }
    if (score <= 0.05) break
    groups[best[0]].push(...groups.splice(best[1], 1)[0])
  }
  return { groups, conflicts, correlation: raw, centered_correlation: centered }
}

export function seedProfiles({ incumbent, entries, model, registry, events, protectedCases }) {
  const byId = new Map(entries.map(entry => [entry.id, entry]))
  const recent = events.slice(-100)
  const cases = registry.cases.map((record, index) => {
    const exposed = recent.filter(event => event.focus?.includes(index))
    const attempts = exposed.filter(event => Number.isFinite(event.delta?.[index]))
    const successes = attempts.filter(event => event.delta[index] >= 0.02).length
    const strata = {}
    for (const event of attempts) {
      const arm = event.arm ?? 'unknown'
      const parent = byId.get(event.parent)
      const level = (parent?.channels.losses[index] ?? 0) > 0.1 ? 'gap' : 'close'
      const key = `${arm}/${level}`
      const group = strata[key] ??= { attempts: 0, successes: 0 }
      group.attempts++
      if (event.delta[index] >= 0.02) group.successes++
      group.difficulty = 1 - (1 + group.successes) / (2 + group.attempts)
    }
    const search = 1 - (1 + successes) / (2 + attempts.length)
    const value = attempts.reduce((sum, event) => sum + Math.max(0, event.delta[index]), 0) /
      Math.max(1, attempts.reduce((sum, event) => sum + (event.seed_cost ?? 1), 0))
    const gap = incumbent.channels.losses[index]
    const loss = incumbent.regression.perSeed[index]
    const explore = 1 / Math.sqrt(1 + exposed.length)
    const priority = clamp(gap) + clamp(loss) + 0.6 * explore +
      0.4 * record.confidence * (record.reference_difficulty ?? 0) + 0.6 * clamp(value * 50)
    return { ...record, index, gap, regression: loss, exposure: exposed.length, effective_attempts: attempts.length, successes,
      search_difficulty: search, budget_value: value, strata, priority,
      protected: protectedCases.includes(index), adaptation: incumbent.effects.interaction[index] }
  })
  const denominator = cases.reduce((sum, item) => sum + Math.exp(item.priority), 0)
  return cases.map(item => ({ ...item, priority: 0.15 / cases.length + 0.85 * Math.exp(item.priority) / denominator }))
}
