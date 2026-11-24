import { acceptedCase, clamp, gain, lexicase, mean, weightedOrder } from './model.js'
import { similarity } from './intelligence.js'

export const PARENTS = Object.freeze({ global: 0.25, lexicase: 0.30, specialist: 0.20,
  robust: 0.10, complementary: 0.10, novelty: 0.05 })

export const WORKERS = Object.freeze({
  global: { weight: 0.30, task: 'Improve the aggregate and local relative score of the parent.' },
  hard: { weight: 0.25, task: 'Target the stalled or high-gap cohort. Diagnose the algorithmic bottleneck and try one targeted change.' },
  transfer: { weight: 0.15, task: 'Port exactly one supported mechanism from a donor into the parent. Preserve baseline behavior elsewhere.' },
  repair: { weight: 0.10, task: 'Restore the documented capability loss while preserving the useful new mechanism.' },
  adaptive: { weight: 0.10, task: 'Combine complementary mechanisms. Route on an interpretable input feature or ordinary search state; document the condition, feasible fallback and one shared time budget.' },
  attribution: { weight: 0.05, task: 'Remove only the specified intervention. Leave its surrounding code, other mechanisms and solver budget intact.' },
  exploration: { weight: 0.05, task: 'Try a structurally different algorithmic direction. Preserve a feasible fallback and explain the core mechanism.' },
})

function ranked(entries, score, size) {
  const used = new Set()
  return [...entries].sort((a, b) => score(b) - score(a)).filter(item => {
    const key = item.source ?? item.id
    if (used.has(key)) return false
    used.add(key)
    return true
  }).slice(0, size).map(item => item.id)
}

export function archives({ entries, groups, cases, mechanisms }) {
  const valid = entries.filter(entry => entry.channels.legal_rate === 1 && entry.safe)
  const byCase = (indices, limit) => ranked(entries.filter(entry => entry.safe &&
      indices.some(index => acceptedCase(entry.raw[index]))),
    entry => mean(indices.map(index => entry.channels.losses[index] * -1)), limit)
  const hard = cases.filter(item => item.difficulty_status === 'CALIBRATED' &&
    item.confidence >= 0.65 && item.reference_difficulty >= 0.65).map(item => item.index)
  return {
    raw: ranked(valid, entry => entry.channels.original_score, 5),
    relative: ranked(valid, entry => entry.channels.relative, 5),
    robust: ranked(valid.filter(entry => entry.regression.allowed), entry => entry.robust, 5),
    seed: cases.map(({ index }) => byCase([index], 2)),
    cluster: groups.map(group => byCase(group, 3)),
    hard: hard.length ? byCase(hard, 5) : [],
    novelty: ranked(entries.filter(entry => entry.safe && entry.channels.legal_rate > 0), entry => {
      const other = entries.filter(item => item.id !== entry.id && item.source !== entry.source)
      const structural = 1 - Math.max(0, ...other.map(item => similarity(entry, item)))
      const behavioral = other.length ? Math.min(...other.map(item => mean(entry.vector.flatMap((value, index) =>
        value === null || item.vector[index] === null ? [] : [clamp(Math.abs(value - item.vector[index]))])))) : 1
      return 0.65 * structural + 0.35 * behavioral
    }, 10),
    mechanism: mechanisms.filter(item => item.status !== 'UNVERIFIED').slice(-20).map(item => item.id),
  }
}

export function complementary(parent, entries, cases, model) {
  return entries.filter(entry => entry.id !== parent.id && entry.source !== parent.source && entry.safe)
    .map(entry => {
      const advantage = cases.reduce((sum, item) => sum + item.priority *
        Math.max(0, gain(entry.raw[item.index], parent.raw[item.index], model.anchor[item.index], model.direction) ?? 0), 0)
      return { id: entry.id, value: advantage - 0.05 * (1 - similarity(parent, entry)) }
    }).filter(item => item.value > 0).sort((a, b) => b.value - a.value)
}

export function chooseParent({ entries, cases, model, archive, settings }, random = Math.random) {
  const available = new Map(entries.map(item => [item.id, item]))
  const all = keys => [...new Set(keys.flat(Infinity))].map(id => available.get(id)).filter(Boolean)
  const focus = weightedOrder(cases, item => item.priority, random)[0]
  const overflow = weightedOrder(entries, entry =>
    1 + (entry.survival === 'yes' ? 1 : 0) + clamp(entry.channels.relative), random).map(entry => entry.id)
  const poolLimit = settings.parent_pool_size ?? 32
  const common = all([[archive.raw[0], archive.relative[0], archive.robust[0]], archive.seed[focus.index],
    archive.hard, archive.cluster.map(group => group[0]), overflow]).slice(0, poolLimit)
  const pools = {
    global: all([archive.raw, archive.relative]), specialist: all([archive.seed[focus.index], archive.hard]),
    robust: all([archive.robust]), complementary: all([archive.robust, archive.raw]), novelty: all([archive.novelty]),
    lexicase: common,
  }
  const weights = { ...PARENTS, ...settings.parent_weights }
  const mode = weightedOrder(Object.keys(pools).filter(key => pools[key].length && weights[key] > 0),
    key => weights[key], random)[0] ?? 'lexicase'
  const pool = pools[mode]
  const parent = mode === 'lexicase' ? lexicase(pool, cases, model, random) : pool[Math.floor(random() * pool.length)]
  const donor = mode === 'complementary' ? complementary(parent, entries, cases, model)[0]?.id : undefined
  return { id: parent.id, mode, donor }
}

export function sourcePatch(before, after) {
  const left = before.split('\n')
  const right = after.split('\n')
  let first = 0
  while (first < Math.min(left.length, right.length) && left[first] === right[first]) first++
  let suffix = 0
  while (suffix < Math.min(left.length, right.length) - first &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix++
  return { line: first + 1, removed: left.slice(first, left.length - suffix), added: right.slice(first, right.length - suffix) }
}

export function delayedCredit(events) {
  const credit = new Map(events.map(event => [event.id, event.reward]))
  const byId = new Map(events.map(event => [event.id, event]))
  for (const descendant of events) {
    const ancestors = []
    let parent = byId.get(descendant.parent)
    while (parent && ancestors.length < 3 && parent.id !== descendant.id && !ancestors.includes(parent.id)) {
      ancestors.push(parent.id)
      parent = byId.get(parent.parent)
    }
    if (descendant.reward <= 0 || !ancestors.length) continue
    const total = ancestors.reduce((sum, _, h) => sum + 0.6 ** (h + 1), 0)
    for (const [h, id] of ancestors.entries()) {
      credit.set(id, credit.get(id) + 0.35 * descendant.reward * 0.6 ** (h + 1) / total)
    }
  }
  return credit
}

export function advisor(events, context) {
  const delayed = delayedCredit(events)
  const totals = new Map()
  for (const event of events.slice(-100)) {
    if (!event.arm || !Number.isFinite(event.reward)) continue
    const action = [event.parent_mode ?? 'custom', event.arm, event.mechanism ?? 'unknown',
      (event.focus_seeds ?? []).join(',')].join('/')
    const item = totals.get(action) ?? { action, arm: event.arm, samples: 0, effective: 0, reward: 0 }
    const weight = event.context === context ? 1 : 0.25
    item.samples++
    item.effective += weight
    item.reward += weight * delayed.get(event.id)
    totals.set(action, item)
  }
  return [...totals.values()].map(item => ({ ...item, mean: item.reward / item.effective,
    ucb: item.reward / item.effective + 0.35 * Math.sqrt(Math.log(events.length + 2) / item.effective) }))
    .sort((a, b) => b.ucb - a.ucb)
}

export function mechanismMemory(events) {
  const controls = new Map(events.filter(event => event.attribution_of).map(event => [event.attribution_of, event]))
  return events.filter(event => event.mechanism && !event.attribution_of && event.patch).map(event => {
    const control = controls.get(event.id)
    return { id: event.id, parent: event.parent, tags: [event.mechanism], patch: event.patch,
      confidence: control?.control_status ?? 'unverified',
      status: control?.control_status === 'paired' ? 'PAIRED' : control || event.reward > 0 ? 'OBSERVED' : 'UNVERIFIED',
      gains: event.delta, regression: event.delta?.map(value => value === null ? null : Math.max(0, -value)),
      target: event.focus_seeds, ablation: control?.id, ablation_gain: control?.delta }
  })
}
