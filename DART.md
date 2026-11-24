# DART-Organon V4 运行说明

OR(seed2) 在 Organon 的 DSH Provider 上运行 V4。10 道 AHC 任务均默认启用。搜索从已有 solution.cpp 开始，正常候选产生全部历史数据。

## 启动和导出

1. 在满足 README 先决条件的 Linux 环境运行 bash setup.sh。安装包位于 dist/，任务用独立副本启动。旧运行的协议与 V4 不兼容，旧 run 可以留在原任务副本中。
2. 在任务副本启动 Evolve Mode，使用项目 PROMPT.md。首次调用 evolve_run 时给定 max_budget，例如 100，每批可设 candidates 为 3。默认搜索 Seed 为 0 到 49。用于本地合法性与晋升检查的生成 Seed 为 50 到 59。
3. 每批结束后读取 run/dart/diagnostics.json，按需要查看 archives.json、responses.json、mechanisms.json 和 adaptive.json。参考难度未知时，优先考虑历史专家缺口、实际探索暴露和变异成功率。
4. 若要修改搜索策略，用原有 evolve_define、evolve_activate。下一次 evolve_run 从同一历史分别尝试旧、新策略，每组至多 3 个候选，Seed 上限相等。只有通过对照才启用新策略。双方实际消耗计入预算，试验分支留在 run/dart/trials/。
5. 执行 python final_eval.py <任务副本> 导出 run/final-solution.cpp 和 run/final.txt。V4 按题目配置从历史真程序选择提交版本。AHC016、025、027 使用本地相对代理，其余交付任务使用原评测器聚合分。可选 robust 优先鲁棒档案。得分相近时优先尾部缺口小、运行时间短的候选。所有导出程序需通过搜索和本地生成验证面板。只有原版评测器、已知本地 Seed 和候选历史进入这一流程。

## 配置

- dart.score_unit 表示题目可解释的计分单位。交付的 AHC 题用整数单位 1。正比例评分默认取对数收益。零分、负分或 gain_mode 设置为 difference 时切换到版本化分位距与 MAD。
- dart.quality_reference 可给出按 Seed 的独立质量界 lower、upper、共同时间秒数 seconds 和依据 source。上下界按收益方向坐标提供。只有具备独立质量依据且有足够历史与算法族，才会发布参考难度。有可信 quality_trace 时可用达标时间，否则用终分达标率。没有质量界时状态为 UNKNOWN。算法族与参考群体来自正常历史。
- dart.min_reference_programs 默认 8，至少需要两族才冻结。冻结后的参考记录在 run/dart/difficulty-reference.json，普通变异只更新动态诊断。有独立质量界且新谱系至少三份不同源码提供显著反证时，新版校准生效，旧版写入 reference-history。
- dart.parent_weights、dart.worker_weights 和 dart.parent_pool_size 控制父代来源、七类 Worker 与 Lexicase 池容量。Meta-Agent 也可以覆盖相关 dart 组件。
- dart.max_seed_calls 是搜索和本地验证的实例调用总上限。最终分数只使用合法评价。运行缓存以源码、协议和 Seed 面板为键。

## 复跑测试

在 plugins/dsh-evolve-loop 安装锁定依赖后运行 npm test。启用 OR_V4_CXX_E2E=1 可额外执行 C++ 端到端测试，需要 g++、Node 22+ 和 Python。项目根目录运行 python -B -m pytest -p no:cacheprovider -q tests。

本地的编译端到端测试使用可复现的评分夹具。真实 ALE-Bench 需要 setup.sh 配置的 Linux Docker 判题环境。模型生成自适应分支的真实收益须通过同预算实验测量。
