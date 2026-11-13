# 两段式闸门 · 第 1 轮评审发现（必须全部关闭）

> 评审运行：`7dbd50e6-d874-441f-a61e-ad4dc081e7fb`；结论 **patch is incorrect**。
> 基线事实：`node scripts/smoke.mjs` = 198 通过 / 0 失败、`biome check` 干净 —— 但用例表恰好绕开了下列边界，所以「全绿」不能作为正确性证据。
> 本文件为准，逐条关闭；每条都要有「改前能红」的实跑证据。

## P1-1 豁免口子：一句 manual 空 ref 自述就让整道闸门放行

位置：`lib/two-phase-gate.js:136-140`（豁免降级分支）

现状：豁免判据只是「条目 text 命中 `/豁免|waiver/i` 且 evidence 非空」，证据可以是 `{kind:'manual', ref:''}` —— 正是 spec §1 要堵的最弱证据。豁免分支还把 `PHASE2`（**完全没有**阶段② 声明，最严重的一格）和 `PHASE2-EVIDENCE` 一起降级成 `notes`。

实跑复现：账本 = R1 自述证据 + W1「豁免：本次按豁免放行」+ manual 空 ref，activity = 两次 `edit` → `checkLedger` 返回 `verdict=complete`、`derived=[]`、`twoPhase.notes=[PHASE2]`；同一份 `renderReport` 又打印「豁免不计入完成」。结论与报告自相矛盾，且等于复现了 §1 的口子。`scripts/smoke.mjs` 里 `tpWaive` 断言 `missing.length === 0` 把这个错误行为钉成了预期。

要求：
1. 豁免**只**降级 `PHASE2-EVIDENCE`；`PHASE2`（无声明）与 `PHASE2-CONTRADICTION` 必须保留为缺口，不可豁免。
2. 豁免条目的证据必须 `kind !== 'manual'`（自述不能自己给自己发豁免）；不满足则豁免不成立。
3. 修正 `tpWaive` 断言：豁免生效时 `PHASE2-EVIDENCE` 进 notes、`PHASE2` 仍在 missing。

## P1-2 只读命令被判成写文件，纯验证回合被翻成 incomplete

位置：`lib/two-phase-gate.js:35`（`SHELL_REDIRECT_RE`）与 `:23`（写特征表）

误判（实测 `mutations > 0`）：`npm test > /dev/null 2>&1`、`grep -n foo lib/index.js > /dev/null`、`git apply --check /tmp/p.patch`（只检查不落地）、`awk "$1 > 3" data.txt`、`node -e "console.log(1 > 0)"`。
漏判（实测 `mutations = 0`）：`npm test 2> /tmp/err.log`、`echo hi>out.txt`、`cmd 1>/tmp/x.log`、`cmd >| file`；`npx biome check --write` 也没被 `/prettier\s+--write/` 覆盖。

后果：同一批只读命令去掉 ` > /dev/null` 后 verdict 就从 incomplete 变回 complete —— 即「已收口的账本 + 纯验证回合」被凭空要求补阶段② 声明。

要求：**先归一化再判定**——复用 `lib/index.js:1260` 已有的 `stripRedirectNoise`（剔 `> /dev/null`、`2>&1`、`>&2`），并像 `lib/index.js:1339` 那样先把 `=>` 抹掉（避免比较运算符被当重定向）；重定向用 `(^|[^0-9])>>?\s*(?![&|])` 且目标非 `/dev/null|/dev/std*` 才算写；写特征表补 `\btee\b`、`biome\s+.*--write`、`cp|mv|rm|touch|truncate`。`git apply` 必须区分 `--check`。

## P1-3 写工具只认 edit/write，run_code 写满全仓也不触发

位置：`lib/two-phase-gate.js:38`（`MUTATION_TOOLS`）+ `:51`（其余名字直接 `return false`）

实测：`run_code` / `apply_patch` / `multi_edit` / `str_replace` / `terminal` / `pwsh` 各写一次 → `required` 全为 false、`mutations` 全为 0。整轮实现走 `run_code`（本宿主一等工具）时闸门完全不介入。

要求：文件类写工具集合扩成 `edit|write|str_replace|multi_edit|apply_patch`；shell 类（`bash|pwsh|terminal|run_code`）走文本分支。**不要另写一份名单**——`lib/index.js:1255` 已有写工具清单（含 `str_replace|multi_edit|apply_patch|bash|pwsh|run_code|terminal`）与 `FS_WRITE_API`（`:1258`），复用/对齐它，并用命令证明两份名单一致（差集为空）。

## P2-1 矛盾检测两个方向都不准

位置：`lib/two-phase-gate.js:115`（`EXPERT_RE` / `MAIN_AGENT_RE` 全文子串匹配）

如实声明被判矛盾：`阶段② 实现：由我完成（方案来自软件架构师）`、`本人完成，参考了 UI 设计师的稿`、`AI 完成，架构建议来自软件架构师` → 全被判 `PHASE2-CONTRADICTION`（`MAIN_AGENT_RE` 不认「我/由我/本人/AI」）。
谎报反而免罪：`阶段② 实现：前端开发者完成（主会话只做验收，没写代码）`、`安全专家完成，主 agent 只是转述` → 全通过（豁免词是全文子串匹配，附一句「主会话」就免罪）。

要求：判据收紧为「**实现者字段的主语**是主会话」，例如 `/(实现者?|实现方)\s*[:：][^，。;]{0,12}(主\s*agent|主会话|我自己|由我|本人|AI)/`；豁免词不再参与全文匹配。英文词加 `\b` 边界。上列 5 个句子逐条加断言（3 条不判矛盾、2 条必须判矛盾）。

## P2-2 单文件 edit 会被数成多个文件，触发本不该有的客观证据要求

位置：`lib/two-phase-gate.js:65-69`（`pathsOf`）

成立条件：edit/write 入参缺 `command/cmd/path/file_path/query` 时，`detailOfArguments`（`lib/replay.js:51-54`）落到 `JSON.stringify` 分支，`pathsOf` 把 `old_string`/`new_string` 里的路径全当文件名。实测单文件 edit（正文提到 `./lib/old.js`、`./lib/new.js`、`lib/index.js:12`）算出 `files = 4`。

要求：`pathsOf` 只在 detailFull 是「单个路径形态」时抽（不含 `{` `"` 与空白），抽不到返回空并让 `needObjective` 按 spec §3.5 的「无法判断 → 不强制」处理 —— **该口径目前只写在注释里，代码没实现**。

## P2-3 派生缺口让收尾门禁出现「还有 0 条没有证据（）」并白烧 steer

位置：`lib/index.js:1511-1517`（`settled`/门禁消息），`:1496`、`:1504`

`settled` 要求 `lc.verdict === 'complete'`，派生缺口会让门禁继续 steer；但消息里缺口数与 id 列表仍用 `open = live.filter(状态 open)` 计算。条目全有证据、只剩派生缺口时，模型收到「当前 1 条契约里还有 0 条没有证据（）」—— 空括号、计数 0，且永远无法靠「补证据」收口，最多白烧 20 次 steer 预算。

要求：`missing`/`openIds` 改为「open 条目 + `verdict.derived`」，派生缺口在消息里单列 id 与 reason。

## P3-1 空账本下 `verdict='empty'` 与 `missing`/`derived` 计数互相矛盾

位置：`lib/index.js:399-400`

空账本 + 有写入动作 → `verdict='empty'` 但 `missing=1`、`derived=[PHASE2]`，报告打印「核验结论：empty（共 0 条 · 缺证据 1 条）」，且该缺口在空账本下永远无法满足。

要求：`items.length === 0` 时跳过派生闸门（early return），或 `derived` 缺口不参与 `empty` 态的 missing 计数。

## P2-4 断言只验「没漏」，`twoPhaseForceEvidence` 零覆盖

位置：`scripts/smoke.mjs:957-970`

1. 8 条边界表绕开了全部误判格（没有 `> /dev/null`、`2> file`、`>>`、`| tee`、`biome --write`、`git apply --check`），所以 P1-2 的回归现在是绿灯。
2. `twoPhaseForceEvidence` 在 smoke 里**一次都没出现**，恒置 false 也不会被抓住（它是用户可见 Config）。
3. `:992-996` 名字写着「变异测试…证明断言真的会红」，实际只是把输入里的 edit 去掉 —— 是输入依赖，不是变异。

要求：补正向断言（该出现的必须出现）与反向断言（不该出现的不能出现）成对；补 `twoPhaseForceEvidence: true` + 单文件 + 仅 manual → 必须产出 `PHASE2-EVIDENCE`；变异测试落成对**实现**的一次真实改动（恒真/恒假或注入 stub），而不是改输入。

## 收尾要求

- 前 3 条 P1 每条都要给出「改前红、改后绿」的实跑输出。
- `node scripts/smoke.mjs` 全绿，用例数报出来；`npm run lint` 干净（既有 1 条 info 在 `lib/replay.js:182`，不属本次）。
- 不动 `strictEvidence` 判定语义、`matchEvidence`、`KIND_ACTION_RE`、`ledger_verify`/oracle 链路。
- 不动仓库既有未提交 WIP（`README.md` / `evidenceVerdicts` 抽取 / `unsupportedItems` 口径 / R3-1 / §9 既有改动），在其之上增改。
- 不要 `git commit` / `push`。
