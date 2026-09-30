# dsh-completion-ledger

**任务契约与完成核验账本** —— 参照 [`dsh-completion-guard`](https://github.com/PerryLink/dsh-completion-guard) 的语义实现的**桌面可用**轻量版。

> 为什么自研：guard 0.8.0 要求先用 `dsh-completion-guard-host-lock` 做 host-lock 注入
> （`inspect → inject → verify-dump`），而该链路要求 profile 与 runtime 两侧都有
> `node_modules/.package-map.json` + CLI 可 `--dump-config`。桌面 profile 由 Electron 独占
> （`dsh --profile desktop --dump-config` 被拒），且本机 0.1.7-rc.2 的各组件（app.asar、
> `@deepseek-ai/dsh`、`dsh-plugin-manager`、自带 pnpm）都不产出该 map 文件
> → `inspect` 恒返回 `active_graph_missing`。所以这里只保留 guard 真正解决问题的三件事，
> 去掉 cohort / 证书 / host-lock 那套受检环境门禁。

## 它做什么

1. **契约账本**：把用户的要求（`requirements`）与约束（`constraints`）逐条落盘；首轮还会自动把
   **用户原话**记为任务简报（不解析、不改写）。
2. **抗压缩**：检测到会话压缩（`session.snapshotEvents()` 里 `compaction/*` 计数增加）或账本有更新时，
   把账本渲染成一条说明**回注**进上下文，要求与证据状态不会随摘要丢失。
3. **完成核验**：宣称「做完了」之前调用 `ledger_check` 逐条对照证据；缺证据就返回 `incomplete`
   与缺口清单，并提醒「有证据但没有任何验证类动作」这类可疑情况。
4. **证据证伪**（本版新增）：工具活动**带命令原文落盘**；`ledger_evidence` 挂证据时立刻把引用与
   「本会话真实发生过的动作」比对 → 自报证据（写了 `pnpm test` 但其实没跑过）当场标成
   `⚠️ 未观察到支撑动作`；`strictEvidence: true` 时这类条目在核验里**直接算缺口**。
5. **收尾门禁**（本版新增）：本轮要结束而账本还没收口时注入一条提醒（**只提醒、不阻断**），
   一轮最多一次；宿主不提供 `agent.inject` 时自动降级为下一次 `pre-step` 补投。
6. **审计**：`<storageDir>/audit.jsonl` 逐行记录核验结论与门禁触发——用来回答「这插件到底干活了没」。
7. **事实来自持久会话日志**（本版新增）：把 `tool/call` / `tool/result` 折成活动清单，
   于是**插件晚装、宿主重启、会话分叉**都不会丢事实；核验优先用重放结果，内存观察只作补充。
   这条设计照搬 `dsh-doublecheck`（「事实只认持久日志，重放即状态」）。
8. **只读 Git 取证**（本版新增）：文件类证据自己去看文件在不在、有没有被 git 跟踪；
   零宿主 API（直接 `execFile('git', …)`，清空 `GIT_*`、10s 超时、1MB 上限、不经 shell）。
9. **交付报告**（本版新增）：`reportFile` 非空时，每次核验把结论、逐条证据、未被支撑的证据
   写成一份 markdown 落到会话工作目录——可归档的交付物，而不是只在会话里说一句「已完成」。

## 证据证伪的口径（刻意保守）

| kind | 是否比对动作 | 说明 |
|---|---|---|
| `manual` | 否（`verified: null`） | 自述证据，明确不参与比对 |
| `command` / `test` / `file` / `browser` / `url` | 是 | 从 `ref` 抽指纹词（忽略 `bash`/`node`/`test` 这类外壳词），与**证据时间之前**的已观察活动比对；命中 ≥ 60% 指纹词即判「有支撑」 |

判不准时**倾向于判成「未被支撑」而不是判成假**：代价只是多一条告警（默认）或一个缺口（严格模式），
不会误删证据。老账本里没有 `verified` 字段的历史证据，会在核验时就地补算。

## 回注消息必须守的宿主契约

回注是一条**真 user 消息**（走 `agent/pre-step` 的 `decision.messages`，与官方
`@deepseek-ai/dsh-agent` 的 `modelSwitchNotice()` 同一写法），所以必须满足
`@deepseek-ai/dsh-llm` 的 `MessageSource` 契约：

| 字段 | 要求 | 违反后果 |
|---|---|---|
| `source` | 必须存在 | 会话投影层读 `source.kind` 直接崩（`failed to project session …`） |
| `source.kind` | **生产者自己的名字**（`completion-ledger`）；`kind: 'plugin'` 这类 catch-all 被拒 | v4 会话格式准入抛 `format v4 message requires a producer-owned source kind` |
| `source.form` | `'notice'` | — |
| `source.summary` | 必填，且 ≤120 字符（用 `boundContextSummary()` 压） | 超出「一行摘要」的语义约定 |

`reinjectMessage()` 是这条契约的唯一实现点，`scripts/smoke.mjs` 把它钉住（含
`assertV4RowAdmission` 真准入 + `kind:'plugin'` 反例必须被拒）。

## 工具

| 工具 | 作用 |
|---|---|
| `ledger_open` | 登记任务简报 / 要求 / 约束（可多次调用追加） |
| `ledger_evidence` | 给某条挂证据：`kind` = command / test / file / browser / url / manual；返回里会说明这条证据**有没有被观察到的动作支撑** |
| `ledger_status` | 看全量账本 + 最近工具活动（优先落盘活动，跨重启可核验）+ 上次核验结论 + 疑似自报证据 |
| `ledger_check` | 完成核验 → `complete` / `incomplete` / `empty`，附缺口、未被支撑的证据与警告；标出事实来源（重放/落盘/内存） |

## 配置（profile patch 里按 id `completion-ledger` 覆盖）

```yaml
- id: completion-ledger
  name: '@dsh-external/dsh-completion-ledger'
  config:
    enabled: true
    storageDir: ''            # 缺省 ~/.dsh/completion-ledger
    autoCaptureBrief: true    # 首轮记录用户原话
    reinjectEveryTurns: 0     # 0 = 只在压缩 / 账本变化 / 首轮时回注
    maxNoteChars: 1800
    registerSection: true     # 注入「收尾纪律」系统提示段
    activityLimit: 20         # 内存里保留的最近工具活动条数
    persistedActivityLimit: 50 # 落盘的活动条数（跨重启核验用；只对已有账本的会话记录）
    strictEvidence: false     # true = 未被动作支撑的证据在核验里直接算缺口
    gateOnStop: remind        # remind = 收尾时若账本未收口则提醒一次；off = 关闭
    audit: true               # 写 audit.jsonl（核验结论 / 门禁触发）
    replayFromSessionLog: true # 从持久会话日志重放工具活动（晚装/重启/分叉后仍可核验）
    gitEvidence: true          # 文件类证据走只读 git 取证（存在性 + 是否被跟踪）
    reportFile: ''             # 非空则每次核验把交付报告写到会话工作目录（如 ledger-report.md）
```

一键严格档：仓库里的 [`strict.patch.yml`](./strict.patch.yml)（照 `dsh-doublecheck` 的 strict 预设做法）
把 `strictEvidence` + `reportFile` + 收尾门禁一起打开，粘进 profile 的 `cordis.patch.yml` 即可。

## 宿主兼容策略（`lib/compat/`）

所有版本相关判断只此一处，三条规矩：

1. **只认持久会话日志**：事实从 `tool/call` / `tool/result` / `turn/*` 这些宿主保证的行类型重放，
   不依赖任何额外服务 API——宿主服务是最容易随版本变形的面。
2. **读侧认多种形态，写侧只写当前形态**：事件源认 `snapshotEvents()` / `events` / `ownEvents()`；
   工具结果认 V4 的 `tool` 角色与旧版包在 `user/message` 里的形态。回注消息永远只按当前
   `MessageSource` 契约写一次。
3. **版本判定用宿主导出的常量**：`@deepseek-ai/dsh-session` 的 `SESSION_FORMAT_VERSION`（本机 = 4），
   拿不到就退化为形态识别，**不做「失败就重写」式试探**。该 peer 是可选增强，
   `scripts/heal-env.sh` 会顺手链上；缺了插件照样装载。

| 文件 | 职责 |
|---|---|
| `lib/compat/index.js` | 事件取数与版本常量（唯一的版本相关代码） |
| `lib/replay.js` | 会话日志 → 活动清单（纯函数：`replayActivity` / `mergeActivity`） |
| `lib/git-evidence.js` | 只读 git 取证（纯函数 + `execFile`，零宿主 API） |

## 存储

`~/.dsh/completion-ledger/<sessionId>.json`（会话无 id 时退化为 cwd 哈希）。结构：

```json
{ "version": 1, "taskBrief": "用户原话节选", "rev": 3,
  "items": [ { "id": "R1", "text": "…", "kind": "requirement", "status": "open",
               "evidence": [ { "at": 0, "kind": "command", "ref": "pnpm test", "note": "exit 0",
                               "verified": true, "reason": "与已观察到的 bash 匹配（2/2 指纹词）" } ] } ],
  "activity": [ { "at": 0, "name": "bash", "ok": true, "detail": "pnpm test", "note": "141 passed", "verifying": true } ],
  "lastCheck": { "at": 0, "verdict": "complete", "missing": 0, "total": 3, "rev": 3, "strictEvidence": false } }
```

旁路写入（`activity` / `lastCheck`）**不动 `rev`**：`rev` 是回注的触发条件，若每次工具调用都 +1，
就会变成每轮都回注一次账本。

## 为什么是纯 ESM（无编译）

本机只有 Electron/asar 打包的 DSH 与 npx 安装副本，**没有带 `packages/` 的 DSH 源码 checkout**，
脚手架默认的 tsc 链路（要求 `DSH_CHECKOUT`）不可用；而宿主只要求 entry 导出 `{ name, apply }`。
所以源码即产物：`lib/index.js`。`scripts/build.sh` 的职责变成交付前自检：

```sh
bash scripts/build.sh   # ① 自检（装载 + 回注消息契约 + 账本纯函数）② peer 链接 ③ 账本目录可写
node scripts/smoke.mjs  # 只跑第 ① 项：64 项断言——宿主 v4 准入与反例、证据证伪、收尾门禁、
                        # 会话日志重放（含旧形态）、只读 git 取证、交付报告、假 ctx 端到端
npm run lint            # biome 检查（见下节）
```

## lint（biome）与 `scripts/heal-env.sh`

本仓库装了 `@biomejs/biome`（devDependency）+ `biome.jsonc`，于是 **dsh-lint-loop 在这个仓库是活的**：
插件按「仓库本地 `node_modules/.bin` → PATH → 配置里的 `linterPath`」解析命令，所以本地装一份即可。

```sh
npm run lint       # = biome check .
npm run lint:fix   # = biome check --write .
```

`biome.jsonc` **只开 linter、关掉 formatter 与 import 重排**：本仓库的排版是手写的，
打开 formatter 会让 `check` 对每个文件都报"格式差异"，把真正的 lint 信号淹掉（想改随时可开，见文件内注释）。

两个实测过的环境坑，都在 `scripts/heal-env.sh` 里自愈（挂在 `postinstall` 上，`npm install` 后自动跑）：

| 坑 | 现象 | 自愈做法 |
|---|---|---|
| `npm i` 把 peer 当 extraneous 剪掉 | 三条软链没了 → 插件 `[no-fiber]`、四个工具全不可见 | 按「含 `@deepseek-ai/dsh` 的完整安装 → 其余」挑宿主副本重建软链，并用 profile 里的 schemastery 版本交叉核对 |
| 宿主 PATH 里没有 `node` | linter 起不来：`env: node: No such file or directory`（exit 127）——Biome 官方 `.bin/biome` 是 `#!/usr/bin/env node` 垫片，而 DSH 桌面端由 Finder 启动，PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin` | 把 `node_modules/.bin/biome` 指向 `@biomejs/cli-*/biome` **原生二进制**（`env -i … biome --version` 可用，彻底不依赖 PATH） |

在 DSH 会话里用它的三个工具时**必须显式传 `repoRoot`**（工作区根不是 git 仓库）：

```
lint_diagnostics { file_path: "lib/index.js", repoRoot: "<本仓库绝对路径>" }
lint_workspace_errors { repoRoot: "<本仓库绝对路径>" }
lint_fix { file_path: "…", repoRoot: "<本仓库绝对路径>" }
```

## 安装（desktop profile）

junction + `package.json` 依赖 + profile 的 `cordis.patch.yml`：

```yaml
- insert:
    - id: completion-ledger
      name: '@dsh-external/dsh-completion-ledger'
```

peer 需链到宿主同实例。**硬依赖三件**（`dsh-tools` / `dsh-llm` / `schemastery`）——缺任何一个都装载失败：
ESM 静态导入会在 fiber 创建前抛出，表现为 loader 里的 `[no-fiber]` 且四个工具全部不可见。
第四件 `dsh-session` 是**可选增强**（compat 层的版本常量），缺了照常装载。
**别手工 `ln -s`，用脚本**（它会挑对宿主副本并做版本核对）：

```sh
bash scripts/heal-env.sh
```
