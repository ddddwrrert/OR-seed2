# OR(seed2) DART

基于 RSI 中 Organon 原仓库的 `fcd1e50`。对应论文是 *Organon: From Evolutionary Search to Recursive Self-Improving Agents for Scientific Discovery*（arXiv:2610.33046v1）。继续沿用 Evolve Mode、候选目录、候选预算，以及 loop、select、mutate、evaluate、survive 五个可替换 provider。

## 运行

1. 使用原 README 的 Linux 安装流程，把 `KIT` 指向此项目，并为该项目使用独立的 `DSH_HOME` 和任务目录。`setup.sh` 安装随项目重新打包的演化插件。
2. 在一个新的 ALE-Bench 任务副本启动 Evolve Mode，使用本项目 `PROMPT.md`。10 个 AHC 任务默认开启 DART。
3. AHC039 已配置三套固定探针。总候选预算至少为 4 时，先以 `candidates: 3` 运行校准。每套探针使用一个候选名额。其余九题尚未配置固定面板，默认以基线尺度降级运行。
4. 查看 `run/dart/diagnostics.json` 和 `run/dart/mutations.jsonl`，继续分批调用 `evolve_run`。通过 `evolve_define` 和 `evolve_activate` 提交策略。下一批从同一快照分出旧策略和新策略，各运行至多 3 个候选。自定义 loop 可调用 `evolve.dartStep()` 和 `evolve.dartDiagnostics()`。
5. 完成后按原流程执行 `final_eval.py`。DART 任务的私有评测读取已认证冠军。

## 评测与决策

| 环节 | 实现 |
| --- | --- |
| 数据 | `run/evals/` 保留原汇总指标、评分方向、逐例 raw score、判定、耗时、内存和输入摘要。原始输入、输出、stderr 和 judge 消息保存在证据引用的 `.trace.json.gz.b64` 中。该文件先做 Base64 解码，再用 gzip 解压。 |
| 预算与缓存 | `run/dart/budget.json` 统计提交判题的实例额度。缓存按任务协议、源码字节、实例面板与时限分账。超时和基础设施错误不进入内容缓存。首次评测前锁定协议。若外部判题镜像、编译器或依赖更换，应在任务配置中更新任意 `dart` 版本字段并启动一个新 run。可设置 `dart.disable_cache` 来关闭内容缓存。 |
| 探针 | 在 `dart.probe_programs` 中把 `greedy`、`multistart`、`refinement` 映射到 `evaluator/` 内三份不同的 C++ 源码。同一源码按 0.5 倍与 1 倍时限评测。显式设置 `allow_generated_probes` 才会由 Worker 生成探针，模型会标为 `generated`。没有完整面板时状态为 `degraded`。 |
| 双锚点 | 统一优化方向后，以初始基线和全预算固定探针的最佳成绩计算锚点。分母取锚距和基线绝对值的 5% 中较大值。两者都为零时校准失败，需要提供能获得非退化锚点的探针。此次升级改变了评测协议及锚点版本，已开始的旧协议运行需使用新任务副本重新校准。 |
| 实例与程序 | 以全预算探针的逐例均值相对于总均值估计固有难度。另记全预算通过率、半预算超时及同源码的双预算增益。程序能力取标准化向量均值，交互取扣除能力和难度效应后的残差。动态缺口是冠军至历史可达上界的距离。以交互、难度和缺口聚类，每簇保留两名专家。 |
| 搜索 | 以难度与缺口加权排列实例，以候选在该例的 MAD 定 epsilon 做 lexicase。专家可以再次被选为父代。诊断型 worker 根据缺口与父代判定、耗时反馈接受任务。上下文 UCB 在针对性修复、广谱变异、专家合成与配对消融之间选择。 |
| 变异与合成 | 保留父子源码哈希、worker 报告、逐例变化与配对消融效果。合成 worker 得到互补专家源码，在单个 solver 内依问题语义和在线诊断路由。评测不向 solver 提供 seed ID，worker 指令禁止实例指纹和查表，晋升前拦截显式 seed ID 与哈希接口。 |
| 晋升 | 冠军要求搜索面板全部通过、官方分和归一化均值与 CVaR 的综合目标改善，并通过固定易例底线、尾部退化保护和验证面板。基线通过的易例最多允许退化原始基线绝对值的 10%。零基线的易例不允许退化。晋升结果记录在 `run/dart/promotions.jsonl`。 |
| 策略回滚 | 从同一起点分叉旧、新策略，应用等额候选与 Seed 评测上限。新策略须产生认证冠军，官方分优于旧策略且 CVaR 不低于旧策略。通过后只合并冠军和对应证据，失败则恢复旧策略。两组实耗都计入正式预算，分支记录在 `run/dart/trials/`，判定写入 `run/dart/strategy-trials.jsonl`。 |

公开搜索种子默认为 0–49，独立生成的验证种子默认为 50–59，可在任务的 `dart.seeds` 与 `dart.validation_seeds` 中配置。私有评分继续由独立脚本执行。实例总额度可通过 `dart.max_seed_calls` 设置。探针难度依赖冻结面板和预算，跨求解器族泛化需要实测。验证面板会多次用于晋升，请保留私有面板用于最终对照。

## 验证

```sh
cd plugins/dsh-evolve-loop
npm test
cd ../..
python -B -m unittest discover -s tests -v
```

集成测试经 DSH 工具、候选目录、Python 子进程与模拟评分器运行，策略回滚经真实 DSH 动态插件 runner。真实 ALE-Bench Docker 判题、模型 worker 生成的合成 solver 泛化、私有评分及与 Organon 的同预算实测收益仍待验证。C++ 静态检查覆盖显式接口，无法自动证明每个语义分支都与实例标识无关。策略试运行是一个预算受限的晋升门槛，因果效果需要用同预算重复实验测量。



## 独立组合 DART 组件

动态插件可用 `ctx.evolve.register(slot, { name, run(input, evolve) })` 注册下表的任一组件，并用 `ctx.effect` 挂接清理。组件沿用 `evolve_define` 和 `evolve_activate` 的试运行、分配层三候选硬上限和回滚机制。可通过 `evolve_plugins` 查看组件栈，也可在自定义 provider 中用 `evolve.dartComponent(slot, input)` 独立调用，用 `{ defaultProvider: true }` 组合默认实现。同一插件可以登记多个组件。

| 槽位 | 输入及返回 |
| --- | --- |
| `dart-calibrate` | `{ baseline, probes, version }` → 探索用难度和锚点模型 |
| `dart-normalize` | `{ result, model }` → 按面板顺序排列的有限数值 |
| `dart-decompose` | `{ vector, model }` → `{ ability, interaction }` |
| `dart-cluster` | `{ entries, model, incumbent }` → `{ cases, groups }`，groups 使用面板下标 |
| `dart-archive` | `{ entries, groups }` → 各簇候选 ID 数组 |
| `dart-parent` | `{ entries, cases }` → 可选池内的父代 ID |
| `dart-arm` | `{ events, context, eligible }` → 可用动作名称 |
| `dart-dispatch` | `{ state, selected }` → worker 任务计划 |
| `dart-rank` | `{ entry, state }` → 挑战者晋升审核顺序使用的优先级 |
| `dart-promote` | `{ id, vector, incumbent, model }` → 是否进入独立面板检查 |

例如，动态插件可单独调整动作选择：

```js
return {
  name: 'prioritize-repair',
  inject: ['evolve'],
  apply(ctx) {
    ctx.effect(() => ctx.evolve.register('dart-arm', {
      name: 'prioritize-repair',
      run({ eligible }) { return eligible.includes('repair') ? 'repair' : eligible[0] },
    }))
  },
}
```

晋升使用固定的运行期参考和硬约束。探索组件自己计算的难度、归一化分和排名可以改变搜索行为。最终仍按固定锚点复算 CVaR、验证独立面板并检查易例原始分。恢复旧运行时也会重新检查已有冠军的易例原始分，违规时退回基线重新参与竞争。

## 同预算策略对照

先暂停 `evolve_run`，从一个已校准且还有足够候选额度的任务复制对照组和实验组：

```sh
python -B strategy_compare.py fork /path/to/ahc008 /path/to/comparison
```

在两个独立 DSH 会话中分别打开返回的任务路径。对照组加载原策略，实验组加载拟检验的策略。两个会话各运行一个批次，使用相同的候选尝试数（1–3 个）、模型和求解条件。策略插件属于 DSH 会话，需要在各自的会话中加载。汇总：

```sh
python -B strategy_compare.py compare /path/to/comparison
```

报告核对候选预算、判题调用量、评测协议和冻结锚点版本，给出双方官方分和 CVaR 增量。候选消耗不相等时，报告不会给出收益差。在线对照用于短批筛选，策略效果仍应通过多次独立对照测量。
