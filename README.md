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
| `ledger_evidence` | 给某条挂证据：`kind` = command / test / file / browser / url / manual |
| `ledger_status` | 看全量账本 + 最近工具活动（内存） |
| `ledger_check` | 完成核验 → `complete` / `incomplete` / `empty`，附缺口与警告 |

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
```

## 存储

`~/.dsh/completion-ledger/<sessionId>.json`（会话无 id 时退化为 cwd 哈希）。结构：

```json
{ "version": 1, "taskBrief": "用户原话节选", "rev": 3,
  "items": [ { "id": "R1", "text": "…", "kind": "requirement", "status": "open",
               "evidence": [ { "at": 0, "kind": "command", "ref": "pnpm test", "note": "exit 0" } ] } ] }
```

## 为什么是纯 ESM（无编译）

本机只有 Electron/asar 打包的 DSH 与 npx 安装副本，**没有带 `packages/` 的 DSH 源码 checkout**，
脚手架默认的 tsc 链路（要求 `DSH_CHECKOUT`）不可用；而宿主只要求 entry 导出 `{ name, apply }`。
所以源码即产物：`lib/index.js`。`scripts/build.sh` 的职责变成交付前自检：

```sh
bash scripts/build.sh   # ① 自检（装载 + 回注消息契约 + 账本纯函数）② peer 链接 ③ 账本目录可写
node scripts/smoke.mjs  # 只跑第 ① 项：26 项断言，含宿主 v4 准入与反例
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

peer 需链到宿主同实例（三件，缺任何一个都装载失败——ESM 静态导入会在 fiber 创建前抛出，
表现为 loader 里的 `[no-fiber]` 且四个工具全部不可见）。**别手工 `ln -s`，用脚本**（它会挑对宿主副本并做版本核对）：

```sh
bash scripts/heal-env.sh
```
