import { expect, it } from 'vitest'
import { calibrate, cvar, fixedEasyFloor, guarded, lexicase, normalized } from '../src/dart/model.js'

const result = (scores: number[]) => ({
  metrics: {
    score_direction: 'minimize',
    seed_results: scores.map((score, seed) => ({ seed, score, judge: 'ACCEPTED' })),
  },
})

it('normalizes minimizing scores across magnitudes and rejects easy-case regression', () => {
  const baseline = result([100, 10000, 500])
  const model = calibrate(baseline, [result([80, 8000, 490])], 'v1')
  expect(normalized(result([90, 9000, 500]), model)).toEqual([0.5, 0.5, 0])
  expect(cvar([0.5, 0.5, 0])).toBe(0)
  expect(guarded([-0.11, 0.8, 0.8], [0, 0, 0], model)).toBe(false)
  expect(guarded([0, 0.8, 0.8], [0, 0, 0], model)).toBe(true)
})

it('can select a hard-case specialist over a higher-mean solver', () => {
  const cases = [{ index: 0, difficulty: 0, gap: 0 }, { index: 1, difficulty: 4, gap: 1 }]
  const entries = [{ id: 'specialist', vector: [0, 2] }, { id: 'mean', vector: [5, 0] }]
  expect(lexicase(entries, cases, () => 0.5)).toBe('specialist')
})

it('preserves normalization under a positive scale change even below one', () => {
  for (const factor of [0.1, 1, 10]) {
    const baseline = result([0])
    const model = calibrate(baseline, [result([-2 * factor])], 'v2')
    expect(normalized(result([-factor]), model)).toEqual([0.5])
  }
  expect(() => calibrate(result([0]), [result([0])], 'v2')).toThrow('degenerate anchors for seed 0')
})

it('estimates difficulty from full runs and records paired budget sensitivity separately', () => {
  const baseline = result([10, 10])
  const full = { ...result([6, 8]), source_sha256: 'frozen' }
  const half = { ...result([8, 9]), source_sha256: 'frozen' }
  const fullProbe = { ...full, metrics: { ...full.metrics, budget_fraction: 1 } }
  const halfProbe = { ...half, metrics: { ...half.metrics, budget_fraction: 0.5 } }
  halfProbe.metrics.seed_results[1].judge = 'TIME_LIMIT_EXCEEDED'
  const model = calibrate(baseline, [fullProbe, halfProbe], 'v2')
  expect(model.cases.map(c => c.difficulty)).toEqual([0, 0])
  expect(model.cases[0]).toMatchObject({ observations: 2, full_observations: 1, budget_gain: 0.5, budget_pairs: 1 })
  expect(model.cases[1]).toMatchObject({ half_timeouts: 1, budget_gain: null, budget_pairs: 0 })
})

it('protects the raw fixed easy-case floor even with a large anchor span', () => {
  const baseline = result([100, 100, 100])
  const model = calibrate(baseline, [result([1, 99, 99])], 'v1')
  const candidate = result([199, 99, 99])
  expect(fixedEasyFloor(candidate.metrics.seed_results, baseline.metrics.seed_results, model)).toBe(false)

  const maximizing = (scores: number[]) => ({
    metrics: { ...result(scores).metrics, score_direction: 'maximize' },
  })
  const maximizingBaseline = maximizing([100, 100, 100])
  const maximizingModel = calibrate(maximizingBaseline, [maximizing([10000, 200, 200])], 'v1')
  const maximizingCandidate = maximizing([1, 190, 190])
  expect(guarded(normalized(maximizingCandidate, maximizingModel), [0, 0, 0], maximizingModel)).toBe(true)
  expect(fixedEasyFloor(maximizingCandidate.metrics.seed_results,
    maximizingBaseline.metrics.seed_results, maximizingModel)).toBe(false)
  expect(fixedEasyFloor(maximizing([90, 190, 190]).metrics.seed_results,
    maximizingBaseline.metrics.seed_results, maximizingModel)).toBe(true)
})
