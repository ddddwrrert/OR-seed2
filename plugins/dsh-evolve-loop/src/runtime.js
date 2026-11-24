/**
 * Runtime changes to the search: the model-facing tools that define, activate
 * and deactivate dynamic plugins which register `evolve` providers.
 *
 * DSH 0.1.7 ships the dynamic plugin runner (`dynamicCordisRunner`, from
 * `@deepseek-ai/dsh-cordis-host-runner`, mounted by the web profile) for
 * programmatic callers, and gives the model no tool for it: `dsh-tool-cordis`
 * only inspects. These tools call the runner's `define`, `run`, `stop` and
 * `undefine` for the calling agent's own session, host code only, and check
 * that each change actually reached the `evolve` provider stacks.
 *
 * @module dsh-evolve-loop/runtime
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { isAbsolute } from 'node:path'
import { runPaths } from './candidates.js'
import { filesOf } from './files.js'
import { readJson, taskConfig } from './dart/store.js'
import { runStrategyTrial } from './dart/trial.js'

/** The runner's id prefix for plugins these tools create (3–6 lowercase letters). */
export const PLUGIN_ID_PREFIX = 'evo'

const RUNNER_MISSING = 'the dynamic plugin runner (dynamicCordisRunner) is not available in this DSH process; '
  + 'the host composition must mount @deepseek-ai/dsh-cordis-host-runner, which the DSH web profile does by default'

/**
 * The runner service, or a clear error when the host composition lacks it.
 * @param {object} ctx - the plugin context.
 * @returns {object} the `dynamicCordisRunner` service.
 */
function runnerOf(ctx) {
  const runner = ctx.get('dynamicCordisRunner')
  if (runner === undefined) throw new Error(RUNNER_MISSING)
  return runner
}

/**
 * The calling agent: dynamic plugins belong to the session that defines them.
 * @param {object} exec - the tool execution context.
 * @returns {object} the agent.
 */
function agentOf(exec) {
  if (exec.agent === undefined) throw new Error('evolve runtime tools need an Agent-backed session')
  return exec.agent
}

/**
 * The slots whose provider stacks differ between two `providerStacks()` snapshots.
 * @param {Record<string, string[]>} before
 * @param {Record<string, string[]>} after
 * @returns {Record<string, { before: string[], after: string[] }>}
 */
export function changedSlots(before, after) {
  const changed = {}
  for (const slot of Object.keys(after)) {
    const a = before[slot] ?? []
    const b = after[slot]
    if (a.length !== b.length || a.some((name, i) => name !== b[i])) changed[slot] = { before: a, after: b }
  }
  return changed
}

/**
 * Warnings about host code that cannot register a provider the way the search expects.
 * They are advice, not refusals: the runner still accepts the package.
 * @param {string} code - the package's host code.
 * @returns {string[]}
 */
export function hostCodeWarnings(code) {
  const warnings = []
  if (!/\bevolve\b/.test(code)) {
    warnings.push('the code never mentions `evolve`; a search provider is registered with `evolve.register(slot, provider)` on the `evolve` service')
  } else if (!/\.register\s*\(|\.replace\s*\(/.test(code)) {
    warnings.push('the code does not call `evolve.register(...)`; activating it will not change any search step')
  }
  if (/\.register\s*\(/.test(code) && !/ctx\.effect\s*\(/.test(code)) {
    warnings.push('`evolve.register(...)` is not inside `ctx.effect(...)`; deactivating the plugin will then not remove the provider')
  }
  if (/\bnode:fs\b|require\s*\(\s*['"]fs['"]\s*\)/.test(code)) {
    warnings.push('`node:fs` does not exist in the dynamic sandbox; persist search state with `evolve.files`')
  }
  return warnings
}

/**
 * A compact, source-free view of one plugin for the model.
 * @param {object} plugin - the runner's plugin inspection.
 * @returns {object}
 */
function pluginView(plugin) {
  const failure = plugin.latestRun?.error
  return {
    plugin_id: plugin.pluginId,
    running: plugin.activeRun === undefined ? null : plugin.activeRun.packageId,
    current_package_id: plugin.currentPackageId ?? null,
    packages: (plugin.packages ?? []).map(pkg => ({ package_id: pkg.packageId, name: pkg.name, purpose: pkg.purpose })),
    ...failure === undefined ? {} : { last_failure: { phase: failure.phase, message: failure.message } },
  }
}

const jsonOutput = {
  schema: { type: 'json' },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

/**
 * Register the runtime tools.
 * @param {object} ctx - the plugin context.
 * @param {import('./evolve.js').Evolve} evolve - the evolve service.
 */
export function registerRuntimeTools(ctx, evolve) {
  const trials = new Map()
  const trialKey = (agent, root) => JSON.stringify([agent.id, root])
  const workspace = agent => isAbsolute(agent?.session?.header?.cwd ?? '') ? runPaths(agent) : {}

  async function restore(runner, agent, trial) {
    const current = runner.inspectPlugin(agent, trial.plugin)
    if (current.activeRun?.packageId === trial.previous) return
    const result = trial.previous
      ? await runner.run(agent, trial.plugin, trial.previous,
        current.activeRun ? 'update' : 'run', AbortSignal.timeout(30000))
      : await runner.stop(agent, trial.plugin)
    if (result.ok !== true || (trial.previous && result.status !== 'running')) {
      throw new Error(`DART strategy rollback failed for ${trial.plugin}: ${result.message ?? result.status}`)
    }
  }

  ctx.tools.register(defineTool({
    name: 'evolve_define',
    description:
      'Record a dynamic plugin that changes the search at runtime, without running it. The code is host JavaScript '
      + 'for the dynamic plugin sandbox; it reaches the search through the `evolve` service, typically '
      + '`ctx.effect(() => evolve.register(slot, provider))` for slot loop, select, mutate, evaluate or survive. '
      + 'Omit plugin_id to create a new plugin; pass an existing plugin_id to add a new version of it (versions are '
      + 'immutable). Returns { plugin_id, package_id, warnings }; warnings flag code that cannot register a provider as '
      + 'expected. Activate it with evolve_activate. Plugins belong to this session and disappear when DSH restarts.',
    parameters: {
      name: { type: 'string', required: true, description: 'Short label for this version, e.g. "tournament select".' },
      purpose: { type: 'string', required: true, description: 'What this change should do to the search, and why.' },
      host_code: { type: 'string', required: true, description: 'Host JavaScript of the dynamic plugin.' },
      plugin_id: { type: 'string', description: 'An existing plugin to add this version to. Omit to create a new plugin.' },
    },
    output: jsonOutput,
    presentCall: args => ({ card: 'generic', title: `Define search change${typeof args?.name === 'string' ? `: ${args.name}` : ''}`, kind: 'edit' }),
    async execute(args, exec) {
      const agent = agentOf(exec)
      const runner = runnerOf(ctx)
      const code = typeof args.host_code === 'string' ? args.host_code : ''
      if (code.trim() === '') throw new Error('evolve_define needs non-empty `host_code`')
      const receipt = runner.define({
        sessionId: agent.id,
        plugin: typeof args.plugin_id === 'string' && args.plugin_id !== ''
          ? { kind: 'existing', pluginId: args.plugin_id }
          : { kind: 'new', idPrefix: PLUGIN_ID_PREFIX },
        name: args.name,
        purpose: args.purpose,
        code: { host: code },
      })
      return { plugin_id: receipt.pluginId, package_id: receipt.packageId, warnings: hostCodeWarnings(code) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'evolve_activate',
    description:
      'Activate a dynamic plugin recorded with evolve_define: start it, or switch a running plugin to another version. '
      + 'package_id defaults to the plugin\'s newest version. Refused while evolve_run is executing, so a step never '
      + 'changes in the middle of an iteration. Returns { ok, plugin_id, package_id, mode, changed, providers, warnings }: '
      + '`changed` lists every search slot whose provider stack changed, `providers` is the stack of every slot after '
      + 'activation (last name active). ok=false carries the failure message and stack. The next evolve_run uses the '
      + 'active providers.',
    parameters: {
      plugin_id: { type: 'string', required: true, description: 'The plugin to activate.' },
      package_id: { type: 'string', description: 'The version to activate. Default: the newest version.' },
    },
    output: jsonOutput,
    presentCall: () => ({ card: 'generic', title: 'Activate search change', kind: 'edit' }),
    async execute(args, exec) {
      const agent = agentOf(exec)
      const runner = runnerOf(ctx)
      if (evolve.running) throw new Error('an evolve run is in progress; activate search changes between evolve_run calls')
      const { task, root } = workspace(agent)
      const dart = task && await taskConfig(task).then(settings => settings.dart?.enabled, error => {
        if (error.code !== 'ENOENT') throw error
        return false
      })
      const key = trialKey(agent, root)
      if (trials.size) throw new Error('Finish the pending DART strategy trial or deactivate its plugin first.')
      const files = dart ? filesOf(root) : undefined
      if (dart && !(await files.exists('dart/model.json'))) {
        throw new Error('Run an initial DART search batch before activating an experimental strategy.')
      }
      const plugin = runner.inspectPlugin(agent, args.plugin_id)
      const packageId = typeof args.package_id === 'string' && args.package_id !== ''
        ? args.package_id
        : plugin.packages.at(-1)?.packageId
      if (packageId === undefined) throw new Error(`dynamic plugin "${args.plugin_id}" has no version to activate`)
      // A running plugin switches versions with `update`; a stopped one starts with `run`.
      const mode = plugin.activeRun === undefined ? 'run' : 'update'
      const before = evolve.providerStacks(Boolean(dart))
      const providersBefore = Object.fromEntries(Object.keys(before).map(slot => [slot, evolve.getProvider(slot)]))
      const response = await runner.run(agent, args.plugin_id, packageId, mode, exec.signal)
      const after = evolve.providerStacks(Boolean(dart))
      const changed = changedSlots(before, after)
      if (dart) {
        const trial = { plugin: args.plugin_id, previous: plugin.activeRun?.packageId, package: packageId }
        const affected = Object.keys(before).filter(slot => providersBefore[slot] !== evolve.getProvider(slot))
        const runnable = affected.length > 0 && affected.every(slot => {
          const provider = evolve.getProvider(slot)
          return typeof (slot.startsWith('dart-') ? provider.run : slot === 'loop' ? provider.run ?? provider['evolve-loop'] :
            slot === 'mutate' ? provider.mutate ?? provider.improve : provider[slot]) === 'function'
        })
        if (response.ok && response.status === 'running' && runnable) {
          trials.set(key, trial)
        } else if (response.ok || affected.length || JSON.stringify(before) !== JSON.stringify(after)) {
          await restore(runner, agent, trial)
          return { ok: false, reason: 'DART activation did not register a runnable provider', providers: evolve.providerStacks(true) }
        }
      }
      if (!response.ok) {
        return {
          ok: false,
          plugin_id: args.plugin_id,
          package_id: packageId,
          mode,
          reason: response.reason,
          message: response.message,
          ...response.stack === undefined ? {} : { stack: response.stack },
          changed,
          providers: after,
        }
      }
      const warnings = []
      if (response.waitingFor.length > 0) {
        warnings.push(`the plugin is waiting for services that do not exist: ${response.waitingFor.join(', ')}; it has not run yet`)
      }
      if (response.status !== 'running') {
        warnings.push(`activation is ${response.status}, not running; a host-only plugin should run at once`)
      }
      if (mode === 'run' && Object.keys(changed).length === 0 && response.waitingFor.length === 0) {
        warnings.push('the plugin is running but no search slot changed; it did not call evolve.register(...)')
      }
      return {
        ok: true,
        plugin_id: response.pluginId,
        package_id: response.packageId,
        ...(dart ? { dart_trial: 'pending', trial_candidates: 3 } : {}),
        mode,
        changed,
        providers: after,
        warnings,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'evolve_deactivate',
    description:
      'Stop a running dynamic plugin; the providers it registered inside ctx.effect are removed and the slot falls back '
      + 'to the provider below it. The plugin and its versions are kept, so evolve_activate can start it again. With '
      + 'remove=true the plugin and every version are deleted. Refused while evolve_run is executing. Returns '
      + '{ ok, changed, providers, warnings }.',
    parameters: {
      plugin_id: { type: 'string', required: true, description: 'The plugin to stop.' },
      remove: { type: 'boolean', description: 'Also delete the plugin and all its versions. Default false.' },
    },
    output: jsonOutput,
    presentCall: () => ({ card: 'generic', title: 'Deactivate search change', kind: 'edit' }),
    async execute(args, exec) {
      const agent = agentOf(exec)
      const runner = runnerOf(ctx)
      if (evolve.running || [...trials.values()].some(trial => trial.running)) {
        throw new Error('an evolve run is in progress; deactivate search changes between evolve_run calls')
      }
      const { task } = workspace(agent)
      const dart = task && await taskConfig(task).then(settings => settings.dart?.enabled, error => {
        if (error.code !== 'ENOENT') throw error
        return false
      })
      const before = evolve.providerStacks(Boolean(dart))
      const response = args.remove === true
        ? await runner.undefine(agent, args.plugin_id)
        : await runner.stop(agent, args.plugin_id)
      const key = trialKey(agent, workspace(agent).root)
      if (response.ok && trials.get(key)?.plugin === args.plugin_id) trials.delete(key)
      const after = evolve.providerStacks(Boolean(dart))
      const changed = changedSlots(before, after)
      const warnings = []
      if (response.ok === true && Object.keys(changed).length === 0) {
        warnings.push('no search slot changed; the plugin registered no provider, or registered it outside ctx.effect and it is still active')
      }
      return { ...response, changed, providers: after, warnings }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'evolve_plugins',
    description:
      'Read-only: list the dynamic plugins this session defined for the search, with their versions, which version is '
      + 'running, and the last activation failure; plus the provider stack of every search slot. Source code is not '
      + 'returned.',
    parameters: {},
    output: jsonOutput,
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: 'generic', title: 'List search changes', kind: 'read' }),
    async execute(_args, exec) {
      const agent = agentOf(exec)
      const runner = runnerOf(ctx)
      return { plugins: runner.listPlugins(agent).map(pluginView), providers: evolve.providerStacks(),
        dart_components: evolve.providerStacks(true) }
    },
  }))

  return async function runWithTrial(args, exec) {
    const agent = agentOf(exec)
    const { root } = runPaths(agent)
    const key = trialKey(agent, root)
    const trial = trials.get(key)
    if (!trial) {
      if (trials.size) throw new Error('A DART strategy trial is pending in another workspace or session')
      return await evolve.run(args, exec)
    }
    if (trial.running) throw new Error('A DART strategy trial is already running')
    trial.running = true
    try {
      const result = await runStrategyTrial({
        trial,
        args,
        files: filesOf(root),
        run: (options, branch) => evolve.run(options, { ...exec, ...branch }),
        activate: async () => {
          const runner = runnerOf(ctx)
          const current = runner.inspectPlugin(agent, trial.plugin)
          const result = await runner.run(agent, trial.plugin, trial.package,
            current.activeRun ? 'update' : 'run', AbortSignal.timeout(30000))
          if (!result.ok || result.status !== 'running') throw new Error('DART trial strategy could not be reactivated')
        },
        rollback: () => restore(runnerOf(ctx), agent, trial),
      })
      if (result.dart_trial.status === 'validated') {
        const refreshed = await evolve.run(args, { ...exec, refreshOnly: true })
        return { ...result, ...refreshed }
      }
      return { ...result, submission_id: (await readJson(filesOf(root), 'dart/submission.json'))?.id }
    } finally {
      trials.delete(key)
    }
  }
}
