import { expect, it } from 'vitest'
import { calibrate, cvar, evaluateChannels, gain, lexicase, normalized, regression } from '../src/dart/model.js'
import { classify, clusterResponses, decomposition, difficultyRegistry, lineageWeights, qualityCost, seedProfiles } from '../src/dart/intelligence.js'
import { archives, complementary, delayedCredit, mechanismMemory, sourcePatch, WORKERS } from '../src/dart/strategy.js'

const cell = (score: number, seed = 0, judge = 'ACCEPTED') => ({ seed, score, judge })
const row = (id: string, values: number[], code = id, parent?: string) => ({
  id, raw: values.map((value, seed) => cell(value, seed)), code, parent, source: code, safe: true,
  fitness: values.reduce((sum, value) => sum + value, 0),
})
const build = (rows: any[], direction = 'maximize', settings = {}) => calibrate({
  baseline: { metrics: { score_direction: direction, seed_results: rows[0].raw } },
  history: rows, weights: [], settings, version: 'v4',
})

it('uses symmetric log gains, preserves units and sums across generations', () => {
  for (const direction of ['maximize', 'minimize']) {
    const expected = direction === 'maximize' ? Math.log(1.2) : -Math.log(1.2)
    const first = build([row('a', [100])], direction)
    const scaled = build([row('a', [100000])], direction)
    expect(gain(cell(120), cell(100), first.anchor[0], first.direction)).toBeCloseTo(expected)
    expect(gain(cell(120000), cell(100000), scaled.anchor[0], scaled.direction)).toBeCloseTo(expected)
    const sum = gain(cell(120), cell(110), first.anchor[0], first.direction)! +
      gain(cell(110), cell(100), first.anchor[0], first.direction)!
    expect(sum).toBeCloseTo(expected)
  }
})

it('selects robust scale for zero and negative scores and represents failure as missing', () => {
  const history = [row('a', [0, -3]), row('b', [12, -1]), row('c', [4, 1])]
  const model = build(history)
  expect(model.relative_mode).toBe('difference')
  expect(model.anchor.every(item => item.scale > 0 && item.mode === 'difference')).toBe(true)
  expect(normalized({ metrics: { seed_results: [cell(0, 0, 'TIME_LIMIT_EXCEEDED'), cell(-3, 1)] } }, model))
    .toEqual([null, 0])
  const scaled = build(history.map(item => ({ ...item, raw: item.raw.map(record => ({ ...record, score: record.score * 5 + 10 })) })),
    'maximize', { gain_mode: 'difference', score_unit: 0.001 })
  expect(gain(cell(12), cell(0), model.anchor[0], model.direction))
    .toBeCloseTo(gain(cell(70), cell(10), scaled.anchor[0], scaled.direction))
})

it('keeps reference difficulty unknown and freezes equal family weights', () => {
  const rows = [
    { ...row('a', [100, 100]), family: 'one' },
    { ...row('b', [110, 100]), family: 'one' },
    { ...row('c', [130, 100]), family: 'two' },
    { ...row('duplicate', [130, 100], 'c'), family: 'two' },
  ]
  const weights = lineageWeights(rows)
  expect(weights.map(item => item.weight).sort()).toEqual([0.25, 0.25, 0.5])
  const registry = difficultyRegistry(rows, weights, build(rows), undefined, undefined, 3)
  expect(registry.frozen).toBe(true)
  expect(registry.cases[0].difficulty_status).toBe('UNKNOWN')
  expect(registry.cases[0].reference_difficulty).toBeNull()
  expect(registry.cases[0].historical_attainment_difficulty).toBeLessThan(registry.cases[1].historical_attainment_difficulty)
  expect(difficultyRegistry(rows.slice(0, 1), [], build(rows), undefined, registry)).toBe(registry)
})

it('uses independently supplied quality bounds with timed or final-only evidence', () => {
  const bounds = { lower: 0, upper: 100, seconds: 2, source: 'proved bound in fixture' }
  expect(qualityCost(cell(75), bounds, 1)).toBe(0.25)
  expect(qualityCost({ ...cell(100), quality_trace: [{ seconds: 0.5, score: 30 }, { seconds: 1, score: 100 }] },
    bounds, 1)).toBeCloseTo((0.25 + 0.5 + 0.5 + 0.5) / 4)
  const rows = [row('a', [100]), row('b', [30])].map(item => ({ ...item, family: item.id }))
  const model = build(rows)
  const registry = difficultyRegistry(rows, lineageWeights(rows), model, { 0: bounds }, undefined, 2)
  expect(registry.cases[0].reference_difficulty).toBeCloseTo(0.375)
  const entries = rows.map(item => ({ ...item, vector: normalized({ metrics: { seed_results: item.raw } }, model) }))
  const fit = decomposition({ entries, model, registry, quality: { 0: bounds } })
  expect(fit[0].ability).toBeGreaterThan(fit[1].ability)
  expect(fit[0].instance_effect[0]).toBeCloseTo(0.375)
})

it('refreshes a frozen reference only for a replicated new family with independent counterevidence', () => {
  const early = [
    { ...row('a', [0]), family: 'a' },
    { ...row('b', [0]), family: 'b' },
  ]
  const quality = { 0: { lower: 0, upper: 100, seconds: 1, source: 'fixture' } }
  const before = difficultyRegistry(early, lineageWeights(early), build(early), quality, undefined, 2)
  const next = [1, 2, 3].map(id => ({ ...row(`c${id}`, [100]), family: 'c' }))
  const partial = [...early, ...next.slice(0, 2)]
  expect(difficultyRegistry(partial, lineageWeights(partial), build(partial), quality, before, 2)).toBe(before)
  const full = [...early, ...next]
  const revised = difficultyRegistry(full, lineageWeights(full), { ...build(full), version: 'revised' }, quality, before, 2)
  expect(revised.normalizer).toBe('revised')
  expect(revised.cases[0].reference_difficulty).toBeCloseTo(2 / 3)
})

it('keeps raw, relative and protected elite lanes independent and uses true tail losses', () => {
  const state = classify([row('a', [100000, 50], 'common baseline'),
    row('b', [95000, 60], 'neighbor improvement', 'a'), row('c', [85000, 100], 'branch alternatives', 'a')], [])
  const model = build(state)
  const entries = state.map(entry => {
    const channels = evaluateChannels(entry, model)
    return { ...entry, vector: normalized({ metrics: { seed_results: entry.raw } }, model),
      channels, regression: regression(entry, state[0], model, [0]), robust: channels.relative - channels.cvar * 0.5 }
  })
  const cases = model.anchor.map((item, index) => ({ ...item, index, priority: index ? 0.9 : 0.1 }))
  const archive = archives({ entries, groups: [[0], [1]], cases, mechanisms: [] })
  expect(archive.raw[0]).toBe('a')
  expect(archive.relative[0]).toBe('c')
  expect(archive.robust).not.toContain('c')
  expect(archive.seed[1][0]).toBe('c')
  expect(lexicase(entries, cases, model, () => 0.5).id).toBe('c')
  expect(complementary(entries[0], entries, cases, model)[0].id).toBe('c')
  expect(cvar(Array.from({ length: 50 }, (_, index) => index))).toBe(44.5)
})

it('weights target selection by verified opportunities and separates exposure and search difficulty', () => {
  const base = row('a', [10, 10])
  const model = build([base, row('b', [11, 20])])
  const incumbent = { ...base, channels: evaluateChannels(base, model),
    regression: regression(base, base, model, [0]), effects: { interaction: [0, 0] } }
  const registry = { cases: [0, 1].map(seed => ({ seed, reference_difficulty: null, confidence: 0 })) }
  const cases = seedProfiles({ incumbent, entries: [incumbent], model, registry, protectedCases: [0],
    events: [
      { parent: 'a', arm: 'hard', focus: [1], delta: [0, 0.2], seed_cost: 50 },
      { parent: 'a', arm: 'repair', focus: [1], delta: [null, null], seed_cost: 50 },
    ] })
  expect(cases[0]).toMatchObject({ exposure: 0, search_difficulty: 0.5, protected: true })
  expect(cases[1]).toMatchObject({ exposure: 2, effective_attempts: 1, successes: 1, strata: { 'hard/gap': { attempts: 1, successes: 1 } } })
  expect(cases[0].priority + cases[1].priority).toBeCloseTo(1)
})

it('clusters historical response and labels conflicts from paired evidence', () => {
  const events = [1, 2, 3, 4].map(value => ({ source: String(value), parent_source: 'p',
    delta: [value, value * 2, -value, null], control_status: value === 3 ? 'paired' : undefined }))
  const clusters = clusterResponses(events, 4)
  expect(clusters.groups.some(group => group.includes(0) && group.includes(1))).toBe(true)
  expect(clusters.conflicts).toContainEqual(expect.objectContaining({ left: 0, right: 2, controlled: true }))
})

it('retains real change evidence and gives causal lineage bounded descendant credit', () => {
  const patch = sourcePatch('init\nold\nreturn', 'init\nnew\nreturn')
  expect(patch).toEqual({ line: 2, removed: ['old'], added: ['new'] })
  const events = [
    { id: 'a', parent: 'base', reward: -0.1, mechanism: 'local move', patch, delta: [-0.1] },
    { id: 'b', parent: 'a', reward: 0.8, delta: [0.2] },
    { id: 'c', parent: 'a', reward: 0.1, attribution_of: 'a', control_status: 'paired', delta: [-0.2] },
  ]
  expect(delayedCredit(events).get('a')).toBeGreaterThan(0.1)
  expect(mechanismMemory(events)[0]).toMatchObject({ status: 'PAIRED', ablation: 'c', regression: [0.1] })
  expect(Object.keys(WORKERS)).toHaveLength(7)
})

