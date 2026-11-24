export const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
export const clamp = (value, low = 0, high = 1) => Math.min(high, Math.max(low, value))
export const acceptedCase = item => item?.judge === 'ACCEPTED' && Number.isFinite(item.score)
export const directionOf = result => result.metrics.score_direction === 'maximize' ? 1 : -1
export function quantile(values, fraction) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const at = fraction * (sorted.length - 1)
  const index = Math.floor(at)
  return sorted[index] + (at - index) * ((sorted[index + 1] ?? sorted[index]) - sorted[index])
}
export const median = values => quantile(values, 0.5)
export const mad = values => {
  const center = median(values)
  return median(values.map(value => Math.abs(value - center)))
}
export function cvar(losses, fraction = 0.2) {
  if (!losses.length) return 0
  const mass = losses.length * fraction
  const sorted = [...losses].sort((a, b) => b - a)
  const whole = Math.floor(mass)
  return (sorted.slice(0, whole).reduce((sum, item) => sum + item, 0) +
    (mass - whole) * (sorted[whole] ?? 0)) / mass
}

export function calibrate({ baseline, history, weights, settings, version }) {
  const baselineCases = baseline.metrics.seed_results
  const direction = directionOf(baseline)
  const panels = history.map(item => item.raw)
  const anchor = baselineCases.map((item, index) => {
    const scores = panels.map(panel => panel[index]).filter(acceptedCase).map(record => record.score)
    const localBest = scores.length ? direction * Math.max(...scores.map(score => score * direction)) : null
    const tau = settings.score_unit ?? (Math.abs(item.score) * 0.05 || median(scores.map(Math.abs)) * 0.05 || 1)
    const scale = Math.max(quantile(scores, 0.9) - quantile(scores, 0.1), 1.4826 * mad(scores), tau)
    const mode = settings.gain_mode !== 'difference' && acceptedCase(item) && item.score > 0 &&
      scores.every(score => score > 0) ? 'log' : 'difference'
    return { seed: item.seed, baseline: item.score, baseline_valid: acceptedCase(item), localBest, scale, mode }
  })
  const relative_mode = anchor.every(item => item.mode === 'log') ? 'ratio' : 'difference'
  return { version, direction, anchor, relative_mode, family_count: new Set(weights.map(item => item.family)).size }
}

function coordinate(score, anchor, direction) {
  if (anchor.mode === 'log' && score > 0) return direction * (Math.log(score) - Math.log(anchor.baseline))
  return (direction * score - direction * anchor.baseline) / anchor.scale
}
export function gain(child, parent, anchor, direction) {
  if (!acceptedCase(child) || !acceptedCase(parent)) return null
  return anchor.mode === 'log' && child.score > 0 && parent.score > 0
    ? direction * (Math.log(child.score) - Math.log(parent.score))
    : (direction * child.score - direction * parent.score) / anchor.scale
}

export function normalized(result, model) {
  return model.anchor.map((anchor, index) => {
    const item = result.metrics.seed_results[index]
    return acceptedCase(item) ? coordinate(item.score, anchor, model.direction) : null
  })
}

const projection = (item, anchor, direction) => acceptedCase(item) && anchor.localBest !== null
  ? Math.max(0, gain({ score: anchor.localBest, judge: 'ACCEPTED' }, item, anchor, direction)) : 1
export function evaluateChannels(entry, model) {
  const losses = model.anchor.map((anchor, index) => projection(entry.raw[index], anchor, model.direction))
  const relative = model.anchor.map((anchor, index) => {
    const item = entry.raw[index]
    if (!acceptedCase(item)) return model.relative_mode === 'ratio' ? 0 : -1
    if (model.relative_mode === 'difference') return (model.direction * item.score - model.direction * anchor.baseline) / anchor.scale
    return model.direction === 1 ? item.score / anchor.localBest : anchor.localBest / item.score
  })
  return { original_score: entry.fitness, relative: mean(relative), cvar: cvar(losses), losses,
    legal_rate: mean(entry.raw.map(item => Number(acceptedCase(item)))) }
}

export function regression(entry, reference, model, protectedCases, settings = {}) {
  const perSeed = model.anchor.map((anchor, index) => {
    const before = reference.raw[index]
    if (!acceptedCase(before)) return 0
    const change = gain(entry.raw[index], before, anchor, model.direction)
    return change === null ? 1 : Math.max(0, -change)
  })
  const loss = mean(perSeed)
  const allowed = loss <= (settings.mean_regression ?? 0.05) && protectedCases.every(index => {
    const anchor = model.anchor[index]
    const before = reference.raw[index]
    const after = entry.raw[index]
    if (!acceptedCase(before)) return true
    if (!acceptedCase(after)) return false
    // A baseline-relative raw limit is fixed across scale revisions.
    const rawLoss = model.direction * (before.score - after.score)
    return rawLoss <= (settings.protected_regression ?? 0.1) * Math.abs(before.score) &&
      perSeed[index] <= (settings.protected_regression ?? 0.1)
  })
  return { allowed, loss, perSeed }
}

export function utility(entry, parent, model, hard = []) {
  const delta = model.anchor.map((anchor, index) => gain(entry.raw[index], parent.raw[index], anchor, model.direction))
  const raw = clamp((entry.fitness - parent.fitness) / (Math.abs(parent.fitness) || Math.abs(entry.fitness) || 1), -1, 1)
  const actual = delta.filter(value => value !== null)
  return 0.25 * raw + 0.35 * mean(actual) + 0.15 * mean(hard.map(index => delta[index]).filter(value => value !== null)) +
    0.25 * (parent.channels.cvar - entry.channels.cvar) - 0.3 * entry.regression.loss
}

export function weightedOrder(items, weight, random = Math.random) {
  return items.map(item => ({ item, key: -Math.log(Math.max(Number.MIN_VALUE, random())) / Math.max(Number.MIN_VALUE, weight(item)) }))
    .sort((a, b) => a.key - b.key).map(({ item }) => item)
}

export function lexicase(entries, cases, model, random = Math.random) {
  let remaining = entries
  for (const { index } of weightedOrder(cases, item => item.priority, random)) {
    if (remaining.length <= 1) break
    const feasible = remaining.filter(entry => acceptedCase(entry.raw[index]))
    if (!feasible.length) continue
    const scores = feasible.map(entry => model.direction * entry.raw[index].score)
    const scale = model.anchor[index].scale
    const tolerance = Math.min(0.25, mad(scores) / scale) * scale
    const best = Math.max(...scores)
    remaining = feasible.filter((_, i) => best - scores[i] <= tolerance)
  }
  return remaining[Math.floor(random() * remaining.length)]
}
