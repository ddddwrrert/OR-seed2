import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export const BASE = 'c000000'
export const DEFAULT_SEEDS = Array.from({ length: 50 }, (_, seed) => seed)
export async function readJson(files, path) {
  const value = await files.read(path)
  return value === undefined ? undefined : JSON.parse(value)
}

export async function writeJson(files, path, value) {
  await files.write(path, JSON.stringify(value, null, 2) + '\n')
}

export function hash(parts) {
  const digest = createHash('sha256')
  for (const part of parts) {
    const bytes = Buffer.from(part)
    digest.update(String(bytes.length)).update(':').update(bytes)
  }
  return digest.digest('hex')
}

async function evaluatorFiles(dir) {
  const parts = []
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '__pycache__') continue
    const path = join(dir, entry.name)
    parts.push(entry.name)
    if (entry.isDirectory()) parts.push(...await evaluatorFiles(path))
    else if (entry.isFile()) parts.push(await readFile(path))
    else throw new Error('DART evaluator directories must contain regular files')
  }
  return parts
}

export async function taskConfig(task) {
  return JSON.parse(await readFile(join(task, 'task.json'), 'utf8'))
}

export async function protocolFor(task, settings, maxBudget) {
  const seeds = settings.dart.seeds ?? DEFAULT_SEEDS
  const validationSeeds = settings.dart.validation_seeds ?? [50, 51, 52, 53, 54, 55, 56, 57, 58, 59]
  const allSeeds = [...seeds, ...validationSeeds]
  if (!seeds.length || !validationSeeds.length || new Set(allSeeds).size !== allSeeds.length ||
      !allSeeds.every(seed => Number.isSafeInteger(seed) && seed >= 0)) {
    throw new Error('DART requires distinct, disjoint search and validation seed lists')
  }
  const options = settings.dart
  for (const [seed, bound] of Object.entries(options.quality_reference ?? {})) {
    if (!seeds.includes(Number(seed)) || !Number.isFinite(bound.lower) || !Number.isFinite(bound.upper) ||
        bound.upper <= bound.lower || !Number.isFinite(bound.seconds) || bound.seconds <= 0 ||
        typeof bound.source !== 'string' || !bound.source.trim()) {
      throw new Error('DART quality reference requires an in-panel seed, documented oriented bounds and a positive time cap')
    }
  }
  if (options.score_unit !== undefined && (!Number.isFinite(options.score_unit) || options.score_unit <= 0)) {
    throw new Error('DART score_unit must be a positive scoring unit')
  }
  if (options.min_reference_programs !== undefined &&
      (!Number.isSafeInteger(options.min_reference_programs) || options.min_reference_programs < 2)) {
    throw new Error('DART min_reference_programs must be at least two')
  }
  if (options.submission_objective !== undefined && !['raw', 'relative', 'robust'].includes(options.submission_objective)) {
    throw new Error('DART submission_objective must be raw, relative or robust')
  }
  if (options.parent_pool_size !== undefined && (!Number.isSafeInteger(options.parent_pool_size) || options.parent_pool_size < 2)) {
    throw new Error('DART parent_pool_size must be at least two')
  }
  const maxSeeds = settings.dart.max_seed_calls ??
    (1 + maxBudget) * (seeds.length + validationSeeds.length)
  if (!Number.isSafeInteger(maxSeeds) || maxSeeds < seeds.length + validationSeeds.length) {
    throw new Error('DART max_seed_calls must cover both panels for the baseline')
  }
  const version = hash([
    'dart-organon-v4', JSON.stringify(settings), JSON.stringify({ seeds, validationSeeds, maxSeeds }),
    ...await evaluatorFiles(join(task, 'evaluator')),
  ])
  return { seeds, validationSeeds, maxSeeds, version }
}

const reservationQueues = new Map()
export async function reserve(evolve, count, purpose) {
  const files = evolve.files
  const { maxSeeds } = evolve.currentRun().dart.protocol
  const previous = reservationQueues.get(files.root) ?? Promise.resolve()
  const queued = previous.catch(() => {}).then(async () => {
    const budget = await readJson(files, 'dart/budget.json') ?? { used: 0, reservations: [] }
    if (budget.used + count > maxSeeds) {
      throw Object.assign(new Error('DART seed evaluation budget exhausted'), { code: 'DART_BUDGET' })
    }
    budget.used += count
    budget.reservations.push({ count, purpose, at: new Date().toISOString() })
    await writeJson(files, 'dart/budget.json', budget)
  })
  reservationQueues.set(files.root, queued)
  try {
    await queued
  } finally {
    if (reservationQueues.get(files.root) === queued) reservationQueues.delete(files.root)
  }
}

export function usable(result, seeds) {
  const cases = result?.metrics?.seed_results
  return Array.isArray(cases) && cases.length === seeds.length &&
    ['maximize', 'minimize'].includes(result.metrics.score_direction) &&
    cases.every((item, index) => item.seed === seeds[index] &&
      Number.isFinite(item.score) && typeof item.judge === 'string' && item.judge !== 'INTERNAL_ERROR')
}

export function accepted(result, seeds) {
  return usable(result, seeds) && result.metrics.seed_results.every(item => item.judge === 'ACCEPTED')
}

