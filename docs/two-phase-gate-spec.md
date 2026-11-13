# 两段式闸门规格（阶段① 方案 / 阶段② 实现）

> 目标：堵住「叫过专家拿方案，然后自己把实现写完，ledger_check 仍然返回 complete」这个静默通过的口子。
> 状态：待实现。基线 `lib/index.js` 1489 行（手写 ESM，无编译步骤）。

## 1. 故障与证据

某编码会话：`summon_experts` 召 3 位专家做只读方案评审（任务书写「不要改文件」——这一步是对的），回稿 14621 字符；方案到手后主 agent 自己完成全部 8 次 `edit` + 3 次 `write` + 38 次 bash 内 python 改写，全程没有再召专家。账本里只有一条「本轮叫了哪些专家／为何不需要」，用一条 **ref 为空的 manual 证据** 就满足了，`ledger_check` 返回 `verdict: complete`。

## 2. 为什么不能只加一条要求

| 做法 | 绕过成本 | 结论 |
|---|---|---|
| `ledger_open` 自动注入「阶段②」条目 | ≈0：`ledger_evidence` 可用 `status: dropped` 且**不需要理由**（`lib/index.js:889`），`checkLedger` 对 dropped 直接 `continue`（`:280`） | 不可用 |
| 只校验「阶段② 条目存在」 | 伪造一行即可；且 schema 里没有 `changedPaths` / `implementer` 字段（`mkItem` `:786` 只有 `{id,text,kind,status,evidence}`） | 不够 |
| 新增一个独立工具 | 只在被主动调用时生效 = 把「必须被检查」降级成「必须被想起」 | 最差 |

**采用**：`checkLedger` 内的**派生闸门**——触发条件取自**已观察动作**（`activity`），不取自模型自己登记的清单；命中后计入 `missing`（**影响 verdict**），**不**只进 `warnings`。

理由：`verdict` 会喂给 turn-stopping 门禁和模型自己的收工判断；只进 warnings 等于「看见告警就当完成」，正是现在漏的那个口子（本轮实测：两条被判 `verified=false` 的 file 证据，verdict 仍是 complete）。

## 3. 判定本体必须是可 require 的独立模块

按仓库根 `AGENTS.md`「判定类代码」硬要求：判定逻辑不许内联，本体放独立模块，交付前实测能被外部 `require`。

**新建 `lib/two-phase-gate.js`**，导出纯函数：

```js
export function evaluateTwoPhase({ items, activity, config })
// → { required, mutations, missing: [{ id, text, reason }], waived }
```

约束：**纯函数**，不读文件、不读时间、不读会话，只吃入参；便于外部 `require` 后直接喂边界输入。

### 3.1 入参

- `items`：账本条目 `[{ id, text, kind, status, evidence: [{ kind, ref, verified }] }]`
- `activity`：已观察动作 `[{ name, detailFull, at, ok }]`（与 `checkLedger` 现有 `activity` 同形）
- `config`：`{ twoPhaseGate?: boolean, twoPhaseForceEvidence?: boolean }`

### 3.2 mutation 判定（只看「本轮有没有改文件」）

命中任一即算 mutation：

| 信号 | 判据 |
|---|---|
| `name === 'edit'` 或 `name === 'write'` | 直接算 |
| `name === 'bash'` 且 `detailFull` 命中写特征 | `/sed\s+-i/`、`/git\s+apply/`、`/prettier\s+--write/`、`/python3?\s+-\s*<</` 且同串含 `open\([^)]*,\s*['"]w`、或 `/\s>\s*[^\s|&]+/`（排除 `>&`） |

**不要**用文件数量、任务类型、路径白名单去判 mutation——那些判据会漂移。只判「有没有写动作」。

### 3.3 触发后要求什么

`twoPhaseGate === false` → 直接 `{ required: false }`（逃生开关）。

`mutations === 0` → `{ required: false }`（纯评审/只给结论的回合不误伤）。

`mutations > 0` → `required: true`，然后找「阶段② 声明条目」：
- 识别：`items` 中存在 `text` 命中 `/阶段\s*②|阶段2|实现者|implementer/i` 的条目，称 `phase2Item`
- 没有 `phase2Item`　→ `missing` 追加一条：`id: 'PHASE2'`，`text: '阶段② 实现交代'`，`reason: '本轮观察到 N 次文件写入，但账本没有登记「阶段② 实现由谁做 / 改了哪些文件」'`
- 有但 `evidence.length === 0` → `reason: '阶段② 条目没有任何证据'`
- 有且有证据 → 继续 3.4 / 3.5

### 3.4 矛盾检测（最关键的一条）

`phase2Item` 的声明文本（拼接 `text` + 各条证据的 `ref`/`note`）若**声明实现者是专家**（命中 `/专家|engineer|architect|developer/i` 且**不**命中 `/主\s*agent|主会话|captain|我自己/i`），而 `mutations > 0`：

→ `missing` 追加 `id: 'PHASE2-CONTRADICTION'`，`reason: '声明「专家实现」但本轮观察到 N 次文件写入来自主会话——账本侧无法证明专家做过实现，请改成如实声明'`

这条的意义：不能证明「专家写了」，但能证明「主会话写了」。把判据从「证明谁写的」反转成「声明与观察是否矛盾」。

### 3.5 客观证据要求（只在必要时）

`phase2Item` 的证据里至少一条 `kind !== 'manual'`（即 `file` / `oracle` / `command` / `test` 等）的要求，**仅在**：

- `config.twoPhaseForceEvidence === true`，**或**
- mutation 涉及 **≥2 个文件**（从 `edit`/`write` 的 `detailFull` 抽路径去重；抽不到路径时按「无法判断」→ 不强制）

不满足 → `missing` 追加 `id: 'PHASE2-EVIDENCE'`，`reason: '阶段② 只有自述证据；本轮改动涉及 N 个文件，需要至少一条非 manual 证据（file / ledger_verify）'`

**单文件或纯文档改动不强制**，这是把误伤摘出去的那一刀。

### 3.6 waived

若 `items` 中存在文末命中原话标记的豁免条目（`text` 命中 `/豁免|waiver/i` 且 `evidence.length > 0`）→ `waived: true`，此时 `missing` 只保留 `PHASE2-CONTRADICTION`（矛盾检测不可豁免），其余降级为 `notes`。豁免**不计入 done**，在报告里单列。

## 4. 接入 `checkLedger`

位置：`lib/index.js:273-376`，在 `311-320` 的 `unsupportedItems` 之后、`321` 的 strict 分支之前。

要求：
1. 调用 `evaluateTwoPhase({ items, activity, config })`
2. `result.missing` 逐条并入 `missing`（**影响 verdict**），条目形状与现有 `missing` 一致，便于 `renderReport` 直接渲染
3. 把这些条目同时塞进 `unsupportedItems` 或新字段 `derived`，并在 `renderReport`（`:459` 起）里单列一节「派生闸门」，写明若干条
4. **不要**改动 `strictEvidence` 的现有语义（那是另一件事，见 §7）

## 5. 验收（缺一不可）

1. **外部可 require 且能喂边界输入**：
   ```bash
   node -e 'import("./lib/two-phase-gate.js").then(m=>{if(typeof m.evaluateTwoPhase!=="function"){console.error("FAIL");process.exit(1)};console.log("OK")})'
   ```
2. **边界输入全覆盖**，每条都要有断言，并贴实跑输出：
   - `activity` 为空数组 → `required:false`
   - 只有 `edit` 1 次、无 phase2 条目 → `missing` 含 `PHASE2`
   - 有 phase2 条目但无证据 → `PHASE2`
   - 声明专家实现 + 有 mutation → `PHASE2-CONTRADICTION`
   - 声明主 agent 实现 + 有 mutation + 单文件 → 不产生 `PHASE2-EVIDENCE`
   - 同上但 ≥2 文件且只有 manual 证据 → `PHASE2-EVIDENCE`
   - `config.twoPhaseGate === false` → `required:false`（逃生）
   - `activity` 里 `name:'bash'` 只读（如 `grep`）→ 不算 mutation
3. **闸门必须能红一次**（变异测试）：把 `edit` 动作从 `activity` 里去掉，`PHASE2` 那条断言必须失败；恢复后通过。
4. **挂进本地命令**：`node scripts/smoke.mjs` 全绿（基线 175 通过 / 0 失败），新用例计入其中，不许只在 CI 跑。
5. `npm run lint`（biome）干净。

## 6. 不做的事

- 不试图证明「专家真的写了文件」——`summon_experts` 只回纯文本、无子会话 id，账本侧不可取证
- 不改 `KIND_ACTION_RE` / `matchEvidence` 的既有语义
- 不动 `ledger_verify` 与 oracle 链路
- 不动仓库里已存在的未提交 WIP（`README.md` / `lib/index.js` / `scripts/smoke.mjs` 的既有改动），只在其上增改

## 7. 已知但本次不修的相邻漏洞

`unverified`（`verified === false`）默认只进 `warnings`，`strictEvidence` 默认 `false`（`:59`、`:330-336`）→ **任何被判假的证据默认不影响 verdict**。这比 manual 更宽，建议后续单独处理（例如让 verdict 出现 `suspicious` 态）。本规格不覆盖它，避免一次改动过大。
