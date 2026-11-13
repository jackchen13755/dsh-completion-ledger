/**
 * dsh-completion-ledger — 任务契约与完成核验账本（桌面可用版）
 *
 * 参照 dsh-completion-guard 的语义，去掉它那套 host-lock / cohort / 证书门禁
 * （那套要求 CLI 管理的 profile，在 Electron 桌面上不可用），保留真正有用的三件事：
 *   1. 契约账本：把用户的要求与约束落盘，并自动记下「最初那句话」；
 *   2. 抗压缩：检测到会话压缩（或账本变化）时，把账本以一条说明回注进上下文；
 *   3. 完成核验：宣称完成前用 ledger_check 逐条对照证据，缺证据就明确报缺口。
 *
 * 纯 ESM、无编译步骤（peer：dsh-tools / dsh-llm / schemastery）。
 * @module dsh-completion-ledger
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, renameSync, copyFileSync, unlinkSync, realpathSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import z from '@deepseek-ai/schemastery';
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { compatReport, eventsInfo } from './compat/index.js';
import { detailOfArguments, entryKey, mergeActivity, replayActivity } from './replay.js';
import { runOracle } from './oracle.js';
import { pendingVerifyTargets, renderOracleResult } from './verify-loop.js';
import { fileEvidenceFacts } from './git-evidence.js';
import { evaluateTwoPhase } from './two-phase-gate.js';
// 写工具清单与写特征表的**唯一**来源：派生闸门（two-phase-gate.js）与本文件的门禁共用，
// 否则「另写一份名单」必然漂移（第 1 轮评审 P1-3：run_code 写满全仓也不触发闸门）。
import { SHELL_TOOLS, WRITE_TOOLS, shellMutationOf, stripArrows, stripRedirectNoise } from './write-signals.js';

export const name = 'completion-ledger';
export const inject = ['tools'];

/** 默认存储目录：~/.dsh/completion-ledger */
export function defaultStorageDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'completion-ledger');
}

export const Config = z.object({
  /** 总开关；false 时不注册任何工具与监听。 */
  enabled: z.boolean().default(true),
  /** 账本目录；缺省 ~/.dsh/completion-ledger。 */
  storageDir: z.string().default(''),
  /** 首轮自动把用户原话记为「任务简报」（不解析、不改写）。 */
  autoCaptureBrief: z.boolean().default(true),
  /** 强制每 N 轮回注一次；0 = 只在检测到压缩 / 账本变化 / 首次进入时注入。 */
  reinjectEveryTurns: z.number().default(0),
  /** 回注文本的字符上限。 */
  maxNoteChars: z.number().default(1800),
  /** 注册系统提示段（提醒模型收尾前走 ledger_check）。 */
  registerSection: z.boolean().default(true),
  /** 记录最近工具活动条数（仅内存，用于核验时判断「有没有真的验证过」）。 */
  activityLimit: z.number().default(20),
  /**
   * 落盘的工具活动条数（跨重启/恢复仍可核验；只对**已有账本**的会话记录）。
   * 比对的是「证据引用 ↔ 本会话真实发生过的动作」，见 matchEvidence()。
   */
  persistedActivityLimit: z.number().default(50),
  /**
   * 证据强度：false（默认）= 自报证据只出告警；true = 「引用未被任何已观察动作支撑」
   * 的条目在 ledger_check 里直接算缺口（拿不出证据的降级为未完成）。
   */
  strictEvidence: z.boolean().default(false),
  /**
   * 两段式派生闸门：本轮**观察到文件写入动作**、而账本没交代「阶段② 实现由谁做 / 改了哪些
   * 文件」时，计入缺口（影响 verdict），不只出告警。false = 逃生开关。
   *
   * 触发条件取自已观察动作（activity），不取自模型自己登记的清单——只校验「条目存在」
   * 伪造一行就绕过了。判定本体在 lib/two-phase-gate.js（纯函数，可外部 require）。
   */
  twoPhaseGate: z.boolean().default(true),
  /** 不论改了几个文件，都要求阶段② 至少有 1 条非 manual 证据（file / ledger_verify）。 */
  twoPhaseForceEvidence: z.boolean().default(false),
  /** 收尾门禁：remind = 本轮要结束而账本未收口时注入一条提醒；off = 关闭。 */
  gateOnStop: z.union(['remind', 'off']).default('remind'),
  /** 审计 JSONL（<storageDir>/audit.jsonl）：记核验结论与门禁触发，便于回看效果。 */
  audit: z.boolean().default(true),
  /** 从持久会话日志重放工具活动（插件晚装/重启/分叉后仍能核验证据）。 */
  replayFromSessionLog: z.boolean().default(true),
  /** 重放条数上限（核验窗口）。设成 50 这类小值会让长会话里早期挂的证据被判成自报。 */
  replayMaxEntries: z.number().default(2000),
  /** 文件类证据走只读 git 取证（存在性 + 是否被跟踪）。纯本地、零宿主 API。 */
  gitEvidence: z.boolean().default(true),
  /** 非空时，每次 ledger_check 把交付报告写到会话工作目录下的该文件名（如 ledger-report.md）。 */
  reportFile: z.string().default(''),
  /**
   * 验收命令（Oracle）。默认关闭：不开时**不注册** `ledger_verify`、不跑任何子进程，
   * 装配行为与没有这段配置时完全一致。
   *
   * 安全前提：`commands` 是**用户**声明的白名单，条目只能引用 id。插件自己 spawn 进程，
   * 绕过了 bash 工具的沙箱与审批，所以绝不能让模型自拟命令（`allow` 是非锚定的后备通道，默认空）。
   */
  verify: z.object({
    enabled: z.boolean().default(false),
    commands: z.array(z.object({ id: z.string(), command: z.string() })).default([]),
    /**
     * 默认命令（宿主级强制闸门）：条目自身没有 `verify` 字段时，逐个套用这些命令 id，
     * 一个 id 跑一次。这样验收**不依赖模型主动登记**——模型没写 verify 也照跑。
     * id 必须同时出现在 `commands` 里；未声明的一律丢弃（调用方过滤 + 一次性 warn）。
     */
    defaultCommands: z.array(z.string()).default([]),
    allow: z.string().default(''),
    timeoutMs: z.number().default(120000),
    tailChars: z.number().default(2000),
    maxSteersPerTurn: z.number().default(3),
    maxSteersPerSession: z.number().default(20),
  }).default({ enabled: false, commands: [], defaultCommands: [], allow: '', timeoutMs: 120000, tailChars: 2000, maxSteersPerTurn: 3 }),
});

/* ────────────────────────── 纯函数（可单测） ────────────────────────── */

/** 会话键：优先 sessionId，退化到 cwd 的哈希。 */
export function sessionKeyOf(sessionId, cwd) {
  if (typeof sessionId === 'string' && sessionId !== '') return sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
  const basis = typeof cwd === 'string' && cwd !== '' ? cwd : 'unknown';
  return `cwd-${createHash('sha1').update(basis).digest('hex').slice(0, 12)}`;
}

export function ledgerPath(dir, key) {
  return join(dir, `${key}.json`);
}

export function emptyLedger(sessionId, cwd) {
  const now = Date.now();
  return { version: 1, sessionId: sessionId ?? null, cwd: cwd ?? null, taskBrief: null, items: [], rev: 0, createdAt: now, updatedAt: now };
}

/** 条目状态推导：有证据 → evidenced（除非显式 done/dropped）。 */
export function effectiveStatus(item) {
  if (item.status === 'done' || item.status === 'dropped') return item.status;
  return (item.evidence?.length ?? 0) > 0 ? 'evidenced' : 'open';
}

/** 活跃（非 dropped）条目。 */
export function liveItems(ledger) {
  return (Array.isArray(ledger?.items) ? ledger.items : []).filter((it) => effectiveStatus(it) !== 'dropped');
}

/* ── 证据证伪：把「模型自报」与「本会话真实发生过的动作」对起来 ── */

/** 比对时忽略的高频词：命令外壳与连接词，它们不构成「这条证据做了什么」的指纹。 */
const EVIDENCE_STOPWORDS = new Set([
  'bash', 'sh', 'zsh', 'node', 'npm', 'pnpm', 'yarn', 'npx', 'run', 'the', 'and', 'for', 'with',
  'exit', 'code', 'true', 'false', 'tmp', 'var', 'usr', 'bin', 'lib', 'src', 'test', 'tests',
]);

/** 从证据引用里抽「指纹词」（纯函数，供核验与单测）。 */
export function evidenceTokens(ref) {
  return String(ref ?? '')
    .toLowerCase()
    .split(/[^a-z0-9_./@-]+/)
    .filter((t) => t.length >= 3 && !EVIDENCE_STOPWORDS.has(t))
    .slice(0, 8);
}

/**
 * 每类证据只允许被「同类动作」支撑。
 *
 * 为什么必须分类型：指纹池是「工具名 + 参数文本」，于是**提到过这条命令**（比如给 subagent
 * 的任务书里写了 `scripts/smoke.mjs`）就能 100% 命中并「支撑」一条命令证据。实测本会话
 * 7 条 `ref='node scripts/smoke.mjs'` 全部报「与已观察到的 summon_experts 匹配（1/1 指纹词）」
 * ——执行确实发生过，但账本指的那条动作是错的。提到 ≠ 做过。
 */
const KIND_ACTION_RE = {
  command: /^(bash|pwsh|sh|zsh|terminal|run_code|node|python)/i,
  test: /^(bash|pwsh|sh|zsh|terminal|run_code|node|python)/i,
  browser: /^browser_/i,
  url: /^(web_fetch|fetch_page|web_search|anysearch)/i,
};

/**
 * 把一条证据与「已观察到的工具活动」比对。
 *
 * 语义边界（刻意保守，避免把真证据判成假的）：
 * - `kind: 'manual'` 是自述证据，**不参与**动作比对 → `verified: null`；
 * - 抽不出指纹词（引用为空/全是停用词）→ `verified: false`（无法核验）；
 * - 只与**同类型**动作比对（命令证据只认执行类工具，见 `KIND_ACTION_RE`）；
 * - 命中阈值取 60% 指纹词，且只与**证据时间之前**的活动比对（时间倒挂不算）。
 *
 * @returns {{ verified: boolean|null, reason: string, matched?: object }}
 */
export function matchEvidence(evidence, activity = [], opts = {}) {
  const kind = String(evidence?.kind ?? 'manual');
  if (kind === 'manual') return { verified: null, reason: 'manual（自述证据，不参与动作比对）' };
  const rawRef = String(evidence?.ref ?? '').trim();
  if (rawRef === '') return { verified: false, reason: '证据引用为空' };
  const tokens = evidenceTokens(rawRef);
  if (tokens.length === 0) {
    // 纯中文引用抽不出 ASCII 指纹词：这是「无法比对」，不是「没做过」——判 false 会误伤真证据。
    return { verified: null, reason: '引用里没有可与动作比对的 ASCII 关键词（中文引用无法比对），未做判定' };
  }
  const factsAvailable = opts.factsAvailable !== false;
  const at = Number(evidence?.at ?? Date.now());
  // 元动作不算「做过这件事」：ledger_* 调用（含它自己的参数文本）不该支撑任何证据。
  const inWindow = (Array.isArray(activity) ? activity : []).filter(
    (a) => Number(a?.at ?? 0) <= at + 1000 && !/^ledger_/.test(String(a?.name ?? '')),
  );
  if (inWindow.length === 0 && !factsAvailable) {
    return { verified: null, reason: `事实不可得（${opts.factsReason ?? '读不到会话日志'}），未做比对——不能据此认定自报` };
  }
  // 类型闸门：命令/测试证据只认执行类动作。**提到过**这条命令的参数文本（任务书、提示词）
  // 不再是「做过」；没有执行类动作时直接判未支撑，并说明是哪一类缺失。
  const actionRe = KIND_ACTION_RE[kind] ?? null;
  const pool = actionRe ? inWindow.filter((a) => actionRe.test(String(a?.name ?? ''))) : inWindow;
  if (actionRe && pool.length === 0) {
    return {
      verified: false,
      reason: `本会话没有观察到任何${kind === 'browser' ? '浏览器' : kind === 'url' ? '抓取' : '执行'}类动作，`
        + `无法支撑这条 ${kind} 证据（在别处**提到过**这条命令不算做过）`,
    };
  }
  let best = null;
  for (const a of pool) {
    // 指纹池只用「动作本身」（工具名 + 参数）：工具**输出文本**里出现同名字符串不算做了这件事。
    // 参数优先取 `detailFull`（不截断）：`detail` 只有 200 字符，长复合命令的尾部指纹会被砍掉，
    // 于是真实跑过的命令被判成自报（实测 6 条证据误伤 2 条）。
    const hay = `${a?.name ?? ''} ${a?.detailFull ?? a?.detail ?? ''}`.toLowerCase();
    const hit = tokens.filter((t) => hay.includes(t)).length;
    // 平局取**时间更晚**的那条：本插件自己让用户「修好后重跑再挂证据」，若平局保留最早那条，
    // 照做之后证据仍判「命中的动作以失败结束」——strict 模式下永久收不了口（实测踩到）。
    if (best === null || hit > best.hit || (hit === best.hit && Number(a?.at ?? 0) >= Number(best.a?.at ?? 0))) {
      best = { hit, a };
    }
  }
  const ratio = best ? best.hit / tokens.length : 0;
  if (best && ratio >= 0.6) {
    // 「跑过」不等于「跑通」：命中活动的 ok 明确为 false 时，这条证据不成立。
    // （ok 是三态：false 明确失败 / true 有据可依 / null 无从判定——null 维持原判定，避免误伤旧账本。）
    if (best.a?.ok === false) {
      const code = best.a?.exitCode ?? null;
      return {
        verified: false,
        matched: best.a,
        nearest: best.a?.detailFull ?? best.a?.detail ?? null,
        reason: `命中的动作以失败结束${code !== null ? `（exitCode=${code}）` : ''}（${best.hit}/${tokens.length} 指纹词）——跑过 ≠ 跑通，请修好后重跑再挂证据`,
      };
    }
    return { verified: true, reason: `与已观察到的 ${best.a?.name ?? '动作'} 匹配（${best.hit}/${tokens.length} 指纹词）`, matched: best.a };
  }
  const nearest = best?.a?.detail ? `；最接近的动作是 \`${String(best.a.detail).slice(0, 80)}\`（${best.hit}/${tokens.length} 指纹词）` : '';
  const hint = best && best.hit > 0
    ? '——如果这条证据其实是**描述**而不是命令原文，请改用 kind=manual；否则请把真正执行过的命令原文填进 ref'
    : '——要么真的跑一遍再挂证据，要么改用 kind=manual 并说明依据';
  return {
    verified: false,
    nearest: best?.a?.detail ?? null,
    reason: `本会话没有观察到与该引用匹配的动作（最高 ${best?.hit ?? 0}/${tokens.length} 指纹词）${nearest}${hint}`,
  };
}

/** 追加一条活动并裁剪到 limit（纯函数）。 */
export function recordActivity(activity, entry, limit = 50) {
  const next = [...(Array.isArray(activity) ? activity : []), entry];
  const max = Math.max(1, Number(limit) || 50);
  return next.length > max ? next.slice(next.length - max) : next;
}

/** 收集「引用了动作、但没有任何已观察动作支撑」的证据（供核验降级用）。 */
/**
 * 逐条证据的判定（**单一来源**）：核验的「疑似自报」与「有证据但全未支撑」两个判断
 * 都从这里取，避免两套逻辑各自漂移（曾经就因为一处看字段、一处重算而打架）。
 */
export function evidenceVerdicts(ledger, activity = [], opts = {}) {
  const out = [];
  for (const it of liveItems(ledger)) {
    for (const ev of it.evidence ?? []) {
      // 判定怎么来的，决定要不要重算：
      //  - 动作类（command/test/browser/url）：**每次核验都重算**。事实来自会话日志，而日志只会变多，
      //    匹配器也会随版本变准；沿用旧的 false 会把「当时窗口太窄」永久钉成「自报」。
      //  - manual / file / oracle：判定来自自述、客观取证或**插件自己执行的验收命令**，不重算
      //    （oracle 根本不产生 tool/call 事件，进不了指纹池——拿池子否它是错的）。
      const actionMatched = ev.kind !== 'manual' && ev.kind !== 'file' && ev.oracle !== true;
      const verdict = actionMatched || ev.verified === undefined
        ? matchEvidence(ev, activity, opts)
        : { verified: ev.verified, reason: ev.reason };
      out.push({ item: it, ev, verdict });
    }
  }
  return out;
}

export function unverifiedEvidenceOf(ledger, activity = [], opts = {}) {
  return evidenceVerdicts(ledger, activity, opts)
    .filter(({ verdict }) => verdict.verified === false)
    .map(({ item, ev, verdict }) => ({
      id: item.id, text: item.text, kind: ev.kind, ref: ev.ref, reason: verdict.reason,
      // 插件自己跑的验收没过 = 客观事实；它不是「自报嫌疑」，措辞必须分开。
      viaOracle: ev.oracle === true,
    }));
}

/** 完成核验：返回 verdict 与逐条缺口。 */
export function checkLedger(ledger, activity = [], opts = {}) {
  const items = Array.isArray(ledger?.items) ? ledger.items : [];
  const strict = opts.strictEvidence === true;
  const missing = [];
  const done = [];
  for (const it of items) {
    const st = effectiveStatus(it);
    if (st === 'dropped') continue;
    if (st === 'done' || st === 'evidenced') done.push(it);
    else missing.push(it);
  }
  const verifying = activity.filter((a) => a.verifying);
  const warnings = [];
  // 只算一次：核验的「疑似自报」与「有证据但全未支撑」两个判断共用同一批判定。
  const verdicts = evidenceVerdicts(ledger, activity, opts);
  const unverifiedAll = verdicts
    .filter(({ verdict }) => verdict.verified === false)
    .map(({ item, ev, verdict }) => ({
      id: item.id, text: item.text, kind: ev.kind, ref: ev.ref, reason: verdict.reason,
      viaOracle: ev.oracle === true,
    }));
  // 两类要分开说：①动作类证据没被任何已观察动作支撑 → 「疑似自报」；
  // ②插件自己跑的验收命令没过 → 客观失败，不是自报，措辞不能混。
  const unverified = unverifiedAll.filter((u) => u.viaOracle !== true);
  // Oracle 只看「最近一次」：修好重跑通过之后，早先那次失败不该再拖住条目（否则永远收不了口）。
  const latestOracleFailed = (it) => {
    const ev = (Array.isArray(it?.evidence) ? it.evidence : []).filter((e) => e?.oracle === true);
    return ev.length > 0 && ev[ev.length - 1].verified !== true;
  };
  const failedVerify = [...done, ...missing]
    .filter(latestOracleFailed)
    .map((it) => ({ id: it.id, text: it.text, reason: '最近一次验收命令未通过' }));
  const downgraded = [];
  // 「有证据、但**没有任何一条被支撑**」的条目：状态是 evidenced，在非 strict 模式下
  // 照样算已满足，于是模型看到「有证据」就宣称完成。单独点出来，别让它长得像做完了。
  //
  // 口径必须是「一条 verified=true 都没有」，而不是「存在未被支撑的证据」：
  // 后者会把「先失败、修好后重跑通过」这个**正常循环**误标（历史里那条失败永远在）。
  const unsupportedItems = done
    .filter((it) => effectiveStatus(it) === 'evidenced')
    .filter((it) => {
      const mine = verdicts.filter((v) => v.item.id === it.id);
      // 两个条件同时成立才算「有证据但全未支撑」：
      //  ①至少有一条被判 false（**manual 判定为 null，本来就不参与比对**，不能因此被标）；
      //  ②没有任何一条被判 true（先失败后通过的正常循环不该被标）。
      return mine.some((v) => v.verdict.verified === false) && !mine.some((v) => v.verdict.verified === true);
    })
    .map((it) => ({ id: it.id, text: it.text }));
  // 派生闸门（两段式：阶段① 方案 / 阶段② 实现）。触发条件取自**已观察动作**——本轮真的
  // 写过文件——而不是模型自己登记的清单；命中后**计入 missing（影响 verdict）**。
  // 只进 warnings 等于「看见告警就当完成」，正是本插件要堵的那个口子。
  //
  // 空账本不跑派生闸门（P3-1）：没有条目就没有「阶段② 条目」可言，算出来只会得到
  // `verdict=empty` + `missing=1` 这种自相矛盾的组合，而那个缺口在空账本下永远无法满足。
  const twoPhase = items.length === 0
    ? { required: false, mutations: 0, files: 0, pathsUnknown: false, missing: [], notes: [], waived: false }
    : evaluateTwoPhase({
      items: liveItems(ledger),
      activity,
      config: { twoPhaseGate: opts.twoPhaseGate, twoPhaseForceEvidence: opts.twoPhaseForceEvidence },
    });
  for (const d of twoPhase.missing) missing.push({ id: d.id, text: d.text, reason: d.reason, derived: true });
  if (twoPhase.required) {
    if (twoPhase.missing.length > 0) {
      warnings.push(
        `派生闸门：本轮观察到 ${twoPhase.mutations} 次文件写入，${twoPhase.missing.length} 条「阶段② 实现交代」缺口`
          + `**已计入 verdict**：${twoPhase.missing.map((m) => m.id).join(', ')}`
          + '——补齐「由谁实现 / 改了哪些文件」的如实声明后再核验',
      );
    } else if (twoPhase.waived) {
      warnings.push(
        `派生闸门：本轮观察到 ${twoPhase.mutations} 次文件写入，阶段② 按豁免条目放行`
          + `（豁免不计入完成，${twoPhase.notes.length} 条要求须在结论里单列）`,
      );
    }
  }
  if (strict && unverifiedAll.length > 0) {
    // 严格模式：拿不出证据的（含验收没过）降级为「未完成」，从已满足里移出。
    const ids = new Set(unverifiedAll.map((u) => u.id));
    for (let i = done.length - 1; i >= 0; i -= 1) {
      if (ids.has(done[i].id)) {
        downgraded.push(done[i]);
        missing.push(done[i]);
        done.splice(i, 1);
      }
    }
  }
  if (missing.length === 0 && items.length > 0 && verifying.length === 0) {
    warnings.push('所有条目都有证据，但本轮没有任何「验证类」动作（命令/测试/核验）被观察到——证据是否为纯手工声明？');
  }
  if (unverified.length > 0) {
    warnings.push(
      `${unverified.length} 条证据未被任何已观察动作支撑（疑似自报）：${unverified.map((u) => u.id).join(', ')}` +
        (strict ? '——已按 strictEvidence 降级为缺口' : '——把 strictEvidence 设为 true 可让它们直接算缺口'),
    );
  }
  if (failedVerify.length > 0) {
    // 失败的 Oracle 是**客观事实**，不是启发式的「疑似自报」，所以不看 strictEvidence：
    // 一律从「已满足」移出。否则 verdict 会是 complete，而 turn-stopping 的 settled 判定
    // 与模型自己的收工判断都直接读 verdict ——「验收没过但结论是完成」正是本插件要根治的东西。
    const failIds = new Set(failedVerify.map((u) => u.id));
    for (let i = done.length - 1; i >= 0; i -= 1) {
      if (failIds.has(done[i].id)) {
        if (!downgraded.some((d) => d.id === done[i].id)) downgraded.push(done[i]);
        missing.push(done[i]);
        done.splice(i, 1);
      }
    }
    warnings.push(
      `${failedVerify.length} 条验收命令**未通过**（插件自己执行的客观结果，不是自报）：${failedVerify.map((u) => u.id).join(', ')}`
        + '——已计为缺口；修好后重跑同一条命令，不要用别的命令糊过去',
    );
  }
  if (unsupportedItems.length > 0) {
    warnings.push(
      `${unsupportedItems.length} 条条目**证据全未被支撑却已计作「有证据」**：${unsupportedItems.map((u) => u.id).join(', ')}` +
        '——它们现在算已满足，不要据此宣称完成',
    );
  }
  if (items.length === 0) warnings.push('账本为空：先用 ledger_open 记录要求，否则核验没有依据。');
  return {
    verdict: items.length === 0 ? 'empty' : missing.length === 0 ? 'complete' : 'incomplete',
    total: items.length, done: done.length, missing: missing.length,
    // 派生闸门的缺口是**算出来的**（不是账本条目）：理由必须一起带出，否则模型只看到
    // 一个 PHASE2 却不知道该补什么。
    missingItems: missing.map((it) => (it.derived === true
      ? { id: it.id, text: it.text, evidence: 0, derived: true, reason: it.reason }
      : { id: it.id, text: it.text, evidence: it.evidence?.length ?? 0 })),
    doneItems: done.map((it) => ({ id: it.id, text: it.text, evidence: it.evidence?.length ?? 0, status: effectiveStatus(it) })),
    unverified,
    failedVerify,
    unsupportedItems,
    // 派生闸门：`derived` 已并入 missing（形状与其它缺口一致，便于缺省渲染），
    // `twoPhase` 供报告单列一节（含豁免降级为 notes 的条目）。
    derived: twoPhase.missing,
    twoPhase: {
      required: twoPhase.required,
      mutations: twoPhase.mutations,
      files: twoPhase.files,
      waived: twoPhase.waived,
      notes: twoPhase.notes,
    },
    downgraded: downgraded.map((it) => it.id),
    warnings,
  };
}

/** 渲染回注说明（紧凑、限长）。 */
export function renderNote(ledger, opts = {}) {
  const limit = opts.maxNoteChars ?? 1800;
  const items = Array.isArray(ledger?.items) ? ledger.items : [];
  const live = items.filter((it) => effectiveStatus(it) !== 'dropped');
  const open = live.filter((it) => effectiveStatus(it) === 'open');
  const withEv = live.filter((it) => effectiveStatus(it) !== 'open');
  const lines = [];
  lines.push('[任务契约账本] 以下要求与证据状态在压缩/恢复后依然有效，收尾前用 ledger_check 逐条核验：');
  if (ledger?.taskBrief) lines.push(`· 任务（用户原话节选）：${String(ledger.taskBrief).replace(/\s+/g, ' ').slice(0, 300)}`);
  if (open.length > 0) {
    lines.push('· 缺证据（未完成）：');
    for (const it of open) lines.push(`    ${it.id} ${String(it.text).replace(/\s+/g, ' ').slice(0, 160)}`);
  }
  if (withEv.length > 0) {
    lines.push('· 已有证据：');
    for (const it of withEv) {
      const ev = (it.evidence ?? []).slice(-1)[0];
      const tag = ev ? `${ev.kind}${ev.ref ? `:${String(ev.ref).slice(0, 80)}` : ''}` : '（无）';
      lines.push(`    ${it.id} ${String(it.text).replace(/\s+/g, ' ').slice(0, 120)} — ${tag}`);
    }
  }
  if (items.length === 0) lines.push('· 账本为空：先用 ledger_open 把要求记下来。');
  lines.push('（ledger_status 看全量；ledger_check 出核验结论；ledger_evidence 挂证据）');
  const text = lines.join('\n');
  return text.length > limit ? `${text.slice(0, limit)}\n…（已截断）` : text;
}

/**
 * 构造一条回注用的 user 消息（纯函数，宿主无关，便于自检）。
 *
 * 宿主契约（`@deepseek-ai/dsh-llm` 的 types/message）：
 * - `source.kind` 答「谁产出的」，由生产者自己声明；catch-all 的 `'plugin'`
 *   会被 v4 会话格式准入拒收（"format v4 message requires a producer-owned
 *   source kind"），缺 `source` 则会让投影层读 `source.kind` 时崩溃。
 * - `source.form` 答「这是什么」；`'notice'` 必须带 `summary`，并用
 *   `boundContextSummary` 压进 120 字符。
 *
 * @param why - 本次回注的原因（检测到压缩 / 账本有更新 / 每 N 轮例行）。
 * @param note - 已渲染并限长的账本文本。
 * @returns 冻结的 user 消息；交给 `agent/pre-step` 的 `decision.messages`。
 */
export function reinjectMessage(why, note) {
  return createUserMessage({
    content: [{ type: 'text', text: `（${why}，自动回注）\n${note}` }],
    source: {
      kind: 'completion-ledger',
      form: 'notice',
      summary: boundContextSummary(`任务契约账本自动回注（${why}）`),
    },
  });
}

/**
 * 收尾门禁的注入消息（与回注同一条 `MessageSource` 契约，见 reinjectMessage 的说明）。
 *
 * 门禁**驱动一步**而不是仅仅留言：宿主文档写明 `agent/turn-stopping` 的 `Stop` 是串行、
 * 被 await 的监听，监听器里 `steer()` 会让「machine re-reads its inbox」并再跑一步。
 * 因此这里用 `steer()` 把模型拉回一步继续收口；`inject()` 只是留给没有 steer 的旧宿主兜底
 * （它的语义是「不唤醒 driver」，本轮结束时就到不了模型）。仍然不做「硬否决」——
 * 要不要收工由模型判断，插件只保证这次判断发生在有人说「还差几条」之后。
 *
 * @param text - 面向模型的提醒正文。
 * @returns 冻结的 user 消息；交给 `agent.steer(...)` / `agent.inject(...)` 或 `decision.messages`。
 */
export function gateMessage(text) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'completion-ledger',
      form: 'notice',
      summary: boundContextSummary('完成门禁：账本还没收口'),
    },
  });
}

/**
 * 交付报告（markdown，纯函数）——参照 dsh-doublecheck 的 gate report：
 * 把核验结论、逐条证据、**未被动作支撑的证据**与事实来源写成一份可交付/可归档的文档，
 * 而不是只在会话里说一句「已完成」。
 */
export function renderReport(ledger, verdict, meta = {}) {
  const items = Array.isArray(ledger?.items) ? ledger.items : [];
  const lines = [];
  lines.push('# 交付报告（任务契约账本）');
  lines.push('');
  lines.push(`- 生成时间：${new Date(meta.at ?? Date.now()).toISOString()}`);
  lines.push(`- 会话：${ledger?.sessionId ?? meta.key ?? '（无 id）'}`);
  if (meta.cwd) lines.push(`- 工作目录：${meta.cwd}`);
  lines.push(`- **核验结论：${verdict?.verdict ?? 'unknown'}**（共 ${verdict?.total ?? items.length} 条 · 有证据 ${verdict?.done ?? 0} 条 · 缺证据 ${verdict?.missing ?? 0} 条）`);
  if (Number.isFinite(meta.replayed)) lines.push(`- 事实来源：会话日志重放 ${meta.replayed} 条 / 落盘 ${meta.persisted ?? 0} 条 / 内存 ${meta.memory ?? 0} 条`);
  if (ledger?.taskBrief) {
    lines.push('');
    lines.push('## 任务');
    lines.push('');
    lines.push(`> ${String(ledger.taskBrief).replace(/\s+/g, ' ').slice(0, 500)}`);
  }
  lines.push('');
  lines.push('## 逐条对照');
  lines.push('');
  lines.push('| 条目 | 类型 | 状态 | 证据 |');
  lines.push('|---|---|---|---|');
  for (const it of items) {
    const st = effectiveStatus(it);
    const ev = (it.evidence ?? [])
      .map((e) => {
        const ref = String(e.ref ?? '').slice(0, 60);
        const mark = e.verified === true ? '✅' : e.verified === false ? '⚠️' : '📝';
        return `${mark} ${e.kind}${ref ? `: ${ref}` : ''}`;
      })
      .join('<br>');
    lines.push(`| ${it.id} | ${it.kind === 'constraint' ? '约束' : '要求'} | ${st} | ${ev || '—'} |`);
  }
  const tp = verdict?.twoPhase;
  if (tp?.required === true) {
    lines.push('');
    lines.push('## 派生闸门（两段式：阶段① 方案 / 阶段② 实现）');
    lines.push('');
    lines.push(`- 本轮观察到 **${tp.mutations} 次文件写入**${tp.files > 0 ? `，涉及 ${tp.files} 个文件` : '（路径不可判断）'}`);
    const derived = Array.isArray(verdict?.derived) ? verdict.derived : [];
    for (const d of derived) lines.push(`- ❌ **${d.id}** ${d.text} — ${d.reason}`);
    const notes = Array.isArray(tp.notes) ? tp.notes : [];
    if (tp.waived === true) lines.push(`- 豁免条目已生效：${notes.length} 条要求降级为提示（**豁免不计入完成**，须在结论里单列）`);
    for (const d of notes) lines.push(`- ⚠️ （豁免提示）${d.id} ${d.text} — ${d.reason}`);
    if (derived.length === 0 && notes.length === 0) lines.push('- 阶段② 已如实交代，且证据满足要求');
  }
  if ((verdict?.unverified ?? []).length > 0) {
    lines.push('');
    lines.push('## ⚠️ 未被动作支撑的证据');
    lines.push('');
    for (const u of verdict.unverified) lines.push(`- ${u.id} \`${u.kind}:${String(u.ref ?? '').slice(0, 80)}\` — ${u.reason}`);
  }
  if ((verdict?.warnings ?? []).length > 0) {
    lines.push('');
    lines.push('## 提示');
    lines.push('');
    for (const w of verdict.warnings) lines.push(`- ${w}`);
  }
  lines.push('');
  lines.push('> 图例：✅ 已被本会话观察到的动作支撑 · ⚠️ 未观察到支撑动作 · 📝 自述证据（manual，不参与动作比对）');
  lines.push('');
  return lines.join('\n');
}

/* ────────────────────────── 插件主体 ────────────────────────── */

export function apply(ctx, config) {
  if (!(config.enabled ?? true)) return;

  const dir = (config.storageDir && String(config.storageDir)) || defaultStorageDir();
  const maxNoteChars = config.maxNoteChars ?? 1800;
  const activityLimit = Math.max(1, config.activityLimit ?? 20);
  const persistedLimit = Math.max(1, config.persistedActivityLimit ?? 50);
  const strictEvidence = config.strictEvidence === true;
  const twoPhaseGate = config.twoPhaseGate !== false;
  const twoPhaseForceEvidence = config.twoPhaseForceEvidence === true;
  const gateMode = config.gateOnStop ?? 'remind';
  const auditEnabled = config.audit ?? true;
  const replayEnabled = config.replayFromSessionLog ?? true;
  const replayMaxEntries = Math.max(persistedLimit, Number(config.replayMaxEntries) || 2000);
  const gitEvidenceEnabled = config.gitEvidence ?? true;
  const reportFile = String(config.reportFile ?? '').trim();
  // 验收命令（Oracle）配置：默认全关，不开就不注册工具、不跑子进程。
  const verifyCfg = config.verify ?? {};
  const verifyEnabled = verifyCfg.enabled === true;
  const verifyCommands = (Array.isArray(verifyCfg.commands) ? verifyCfg.commands : [])
    .filter((c) => c && typeof c.id === 'string' && c.id.trim() !== '' && typeof c.command === 'string' && c.command.trim() !== '')
    .map((c) => ({ id: c.id.trim(), command: c.command }));
  // 默认命令（宿主级强制闸门）：条目自身没有 verify 时逐个套用。
  // **先按 `commands` 的 id 白名单过滤**：未声明的 id 一律丢弃（模型不能靠它在收尾时自拟命令），
  // 且只在装配时 warn 一次——配置写坏是用户侧问题，不该在每轮收尾刷屏，更不能让 verify 崩。
  const declaredCommandIds = new Set(verifyCommands.map((c) => c.id));
  const rawDefaultIds = (Array.isArray(verifyCfg.defaultCommands) ? verifyCfg.defaultCommands : [])
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter((x) => x !== '');
  const unknownDefaultIds = rawDefaultIds.filter((id) => !declaredCommandIds.has(id));
  if (unknownDefaultIds.length > 0) {
    console.warn(`completion-ledger: verify.defaultCommands 里有未在 verify.commands 声明的 id，已忽略：${unknownDefaultIds.join(', ')}`);
  }
  const verifyDefaultCommands = [...new Set(rawDefaultIds.filter((id) => declaredCommandIds.has(id)))];
  const verifyAllow = typeof verifyCfg.allow === 'string' ? verifyCfg.allow.trim() : '';
  // allow 按**字面量逐行精确匹配**，不做正则：
  // 正则既允许 `.*` 这种全开，也会因为未转义的字面命令（含 `(`/`+`）编译失败而静默全拒。
  const verifyAllowList = verifyAllow === ''
    ? []
    : verifyAllow.split('\n').map((s) => s.trim()).filter((s) => s !== '');
  const verifyTimeout = Math.max(1000, Number(verifyCfg.timeoutMs) || 120000);
  const verifyTail = Math.max(200, Number(verifyCfg.tailChars) || 2000);
  const verifyMaxSteers = Math.max(0, Number(verifyCfg.maxSteersPerTurn ?? 3) || 0);
  // 会话级总额：宿主不给 turn 时（或反复 steer 时）由它兜底，避免无上限驱动。
  const verifyMaxSession = Math.max(0, Number(verifyCfg.maxSteersPerSession ?? 20) || 0);
  const sessions = new Map();
  /** 读账本时遇到的问题（区分「没有账本」与「账本坏了」），供 status/门禁披露。 */
  const readIssues = new Map();
  /** 已经备份过损坏账本的 key（避免每次读都再复制一份）。 */
  const backedUpCorrupt = new Set();
  /** 最近一次写失败的原因，供工具返回与 status 披露。 */
  const lastWriteError = new Map();

  const state = (key) => {
    let s = sessions.get(key);
    if (!s) {
      s = {
        key, compactions: 0, rev: -1, injected: 0, turns: 0, activity: [],
        briefed: false, gateNotifiedTurn: null, gateFallback: null,
        /** agent/created 判定需要「下一次 pre-step 必须回注一次」（新建/恢复/压缩重建）。 */
        forceReinject: false,
      };
      sessions.set(key, s);
    }
    return s;
  };

  const readLedger = (key) => {
    const p = ledgerPath(dir, key);
    if (!existsSync(p)) {
      readIssues.delete(key);
      return null;
    }
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8'));
      if (!parsed || typeof parsed !== 'object') throw new Error('账本内容不是对象');
      if (!Array.isArray(parsed.items)) parsed.items = [];
      readIssues.delete(key);
      // 读成功就把「已备份过」的记号清掉：否则第二次损坏不会再备份，第二份现场证据丢失。
      backedUpCorrupt.delete(key);
      return parsed;
    } catch (err) {
      // **损坏必须与「没有账本」区分**：过去统一返回 null，于是下一次写入会把坏掉的账本
      // 直接覆盖成空账本 —— 一次崩溃丢掉全部契约与证据，且用户收不到任何提示。
      const reason = String(err?.message ?? err).slice(0, 160);
      readIssues.set(key, { at: Date.now(), reason });
      if (!backedUpCorrupt.has(key)) {
        try {
          copyFileSync(p, `${p}.corrupt-${Date.now()}`);
          // 只有真的备份成功才记账：否则拷贝失败一次之后就再也不会重试。
          backedUpCorrupt.add(key);
        } catch { /* 备份失败也必须继续告警 */ }
      }
      ctx.logger?.warn?.(`completion-ledger: 账本 ${key} 损坏或不可解析（已备份 .corrupt），按空账本继续 ${reason}`);
      return null;
    }
  };

  /**
   * 同一账本 key 的「读-改-写」串行队列。
   *
   * 必要性：`ledger_evidence` 在读到账本之后要 `await` 只读 git 取证，而**每一次工具调用**都会
   * 走 `tools/post-execute` 的 `appendActivity` 写同一份账本。两段交错就会互相覆盖
   * （实测：并发一次「挂文件证据」+ 一次 bash 记账，活动被覆盖丢失；反之则证据丢失）。
   * 宿主支持并行工具调用，这不是理论竞态。
   */
  const writeChains = new Map();
  const withLedgerLock = (key, fn) => {
    const prev = writeChains.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(() => {}, () => {});
    writeChains.set(key, tail);
    tail.then(() => {
      if (writeChains.get(key) === tail) writeChains.delete(key);
    });
    return run;
  };

  /**
   * 写账本。
   *
   * `bumpRev: false` 用于「记账但不改变契约」的旁路写入（工具活动、上次核验结论）：
   * rev 是回注的触发条件（`agent/pre-step` 里比对 `ledger.rev !== s.rev`），
   * 若每次工具调用都 +1，就会变成每轮都回注一次账本——噪音。
   */
  const writeLedger = (key, ledger, { bumpRev = true, clearError = bumpRev } = {}) => {
    const p = ledgerPath(dir, key);
    const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    try {
      mkdirSync(dir, { recursive: true });
      if (bumpRev) ledger.rev = (ledger.rev ?? 0) + 1;
      ledger.updatedAt = Date.now();
      // 原子写：先写同目录临时文件，再 rename（同分区 rename 是原子操作）。
      // 直写终态时，崩溃 / 磁盘满 / 被中断都会留下半截 JSON，而读侧无法与「没有账本」区分。
      writeFileSync(tmp, JSON.stringify(ledger, null, 1), 'utf8');
      renameSync(tmp, p);
      const s = state(key);
      if (bumpRev) s.rev = ledger.rev;
      // 只让「同语义的写」清掉错误：否则一次成功的旁路记账（活动落盘）会把
      // 「刚才证据没写进去」这个告警抹掉，模型就不再被告知结果没落盘。
      if (clearError) lastWriteError.delete(key);
      return true;
    } catch (err) {
      // 失败必须能被调用方看见：只 warn 而忽略返回值时，磁盘满的现场表现是
      // 「工具说 ✅ 已挂证据，但账本没变」，模型据此对外宣称完成。
      const reason = String(err?.message ?? err).slice(0, 160);
      // 清掉写了一半的临时文件：每次失败都留一份含完整账本（任务简报 + 全部证据）的副本。
      try { unlinkSync(tmp); } catch { /* 可能根本没创建成功 */ }
      lastWriteError.set(key, { at: Date.now(), reason });
      ctx.logger?.warn?.(`completion-ledger: 写入账本失败 ${String(err)}`);
      return false;
    }
  };

  /** 写失败时的统一告警行（工具返回里必须带上，不能让模型以为写成功了）。 */
  const writeWarning = (key) => {
    const err = lastWriteError.get(key);
    return err
      ? `\n⚠️ 账本写入失败（${err.reason}）：本条结果**没有落盘**，不要据此宣称完成。`
      : '';
  };

  /**
   * 把「命令 id 或命令原文」解析成一条可执行命令。
   *
   * 只认**用户声明**的 id：`runOracle` 走 `execFile`，绕过 bash 工具的沙箱与审批，
   * 所以模型不能自拟命令。`verify.allow` 只是非锚定的后备通道（默认空 = 关闭）。
   */
  const resolveVerifyCommand = (raw) => {
    const key = String(raw ?? '').trim();
    if (key === '') return { ok: false, reason: '没有给验收命令 id。' };
    const hit = verifyCommands.find((c) => c.id === key);
    if (hit) return { ok: true, id: hit.id, command: hit.command };
    // 字面量精确匹配（不经正则）：模型即使能读到 allow 的内容，也只能用它逐字写过的那条命令。
    if (verifyAllowList.includes(key)) return { ok: true, id: null, command: key };
    const known = verifyCommands.map((c) => c.id).join(', ') || '（未声明任何命令）';
    return {
      ok: false,
      reason: `验收命令只能引用用户声明过的 id：${known}。把这条命令加到 profile patch 的 verify.commands 里再用`
        + '（插件自己 spawn 进程，绕过沙箱与审批，所以不允许模型自拟命令）。',
    };
  };

  /**
   * 把 Oracle 结果登记成证据。
   *
   * `oracle: true` 让核验**不**再拿会话活动池去否它：插件自己执行的命令不产生 `tool/call`
   * 事件，指纹池里查不到，用池子判它就是错的（这也是当初否掉「让 ledger 认 pua 的 verify」的原因）。
   * 只在锁内重读一次账本再挂，避免与并发的记账互相覆盖。
   */
  const attachOracleEvidence = (key, itemId, commandId, command, result) => withLedgerLock(key, () => {
    const fresh = readLedger(key);
    if (!fresh) return false;
    const target = fresh.items.find((i) => i.id === itemId);
    if (!target) return false;
    target.evidence.push({
      at: Date.now(),
      kind: 'command',
      ref: String(command).slice(0, 500),
      note: `Oracle 执行（命令 id=${commandId ?? 'inline'}）：${result.reason}（${result.durationMs ?? '?'}ms）`.slice(0, 500),
      oracle: true,
      verified: result.ok === true,
      reason: `插件自己执行的验收命令：${result.reason}`,
      exitCode: result.exitCode ?? null,
    });
    return writeLedger(key, fresh);
  });

  /** 审计 JSONL：一行一件事，供事后回看「插件到底干活了没」。 */
  const audit = (event) => {
    if (!auditEnabled) return;
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, 'audit.jsonl'), `${JSON.stringify({ at: Date.now(), ...event })}\n`, 'utf8');
    } catch { /* 审计尽力而为，绝不影响主流程 */ }
  };

  /** 只对**已有账本**的会话记录工具活动（不因为一次工具调用就凭空造出账本）。 */
  const appendActivity = (key, entry) => withLedgerLock(key, () => {
    try {
      const ledger = readLedger(key);
      if (!ledger) return false;
      ledger.activity = recordActivity(ledger.activity, entry, persistedLimit);
      return writeLedger(key, ledger, { bumpRev: false });
    } catch (err) {
      ctx.logger?.warn?.(`completion-ledger: 记录工具活动失败 ${String(err)}`);
      return false;
    }
  });

  /**
   * 事实取数（核验的唯一入口）：**重放（持久会话日志）优先**，落盘活动与内存观察只补重放没有的。
   *
   * 这样做的理由（借 dsh-doublecheck 的设计）：重放来自宿主自己保证的会话格式，
   * 插件晚装、宿主重启、会话分叉都不会丢事实；而内存观察只覆盖「插件在跑的那一段」。
   */
  const factsFor = (session, ledger) => {
    const key = sessionKeyOf(session?.id, session?.header?.cwd);
    const persisted = Array.isArray(ledger?.activity) ? ledger.activity : [];
    const info = eventsInfo(session);
    // 重放整段会话（上限 replayMaxEntries，默认 2000）：
    // 只按「最近 N 条」裁剪会让长会话里**早期挂的证据**全部掉出窗口并被判成自报——
    // 实测本会话 11 条真证据全部误伤；而「按证据时间往前 2 秒」也不对（动作可能更早）。
    const replayed = replayEnabled ? replayActivity(info.events, { limit: replayMaxEntries }) : [];
    const memory = state(key).activity;
    // 「事实不可得」必须能与「真的没有活动」区分：否则会把读不到日志说成用户自报证据。
    const replayAvailable = replayEnabled ? info.available : true;
    return {
      activity: mergeActivity(replayed, persisted, memory),
      replayed: replayed.length,
      persisted: persisted.length,
      memory: memory.length,
      replayAvailable,
      eventsSource: info.available ? info.source : `${info.source}${info.error ? ` ${info.error}` : ''}`,
      factsReason: replayAvailable ? null : `会话事件源不可用（${info.source}）`,
    };
  };

  const ensureLedger = (key, sessionId, cwd) => readLedger(key) ?? emptyLedger(sessionId, cwd);

  const sessionOf = (exec) => exec?.agent?.session;
  const keyOf = (session, exec) => sessionKeyOf(session?.id, session?.header?.cwd ?? exec?.agent?.cwd);

  /**
   * 把「这次 runOracle 属于哪个会话」透传给验收命令。
   *
   * 为什么需要：验收命令在**会话 cwd** 下跑，但同一 cwd 下可能有多个会话。像
   * `dispatch-check` 这种要读会话日志的命令，光按 cwd 猜会读错会话，于是它需要
   * 一个确定的会话标识 —— 由插件给出，比让命令自己扫目录可靠。
   *
   * 取 `session.id`（宿主原生 uuid）；拿不到时退回账本的 `key`（`sessionKeyOf` 的产物，
   * 同一会话在同一 cwd 下稳定，且已做过文件名安全化）。两者都没有就不塞这个键，
   * 而不是塞一个空串（空串会让命令以为「有会话标识」却解析不出东西）。
   */
  const oracleSessionEnv = (session, key) => {
    const id = typeof session?.id === 'string' && session.id !== '' ? session.id : key;
    return typeof id === 'string' && id !== '' ? { DSH_SESSION_ID: id } : {};
  };

  /** 统计会话事件里的压缩次数（snapshotEvents 是 rc.1+ 的公开 API）。 */
  const compactionCount = (session) => {
    try {
      const evs = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : session?.events ?? [];
      if (!Array.isArray(evs)) return 0;
      let n = 0;
      // 只认压缩生命周期事件。`compaction/prune` 来自工具结果裁剪器，
      // **每裁剪一条 tool/result 就 append 一次**（dsh-compaction-tool-result-pruner:159），
      // 把它算成「会话压缩」会让长会话每轮都误判一次并反复回注账本。
      for (const e of evs) {
        if (e?.type === 'compaction/start' || e?.type === 'compaction/end') n += 1;
      }
      return n;
    } catch {
      return 0;
    }
  };

  const textOfBlocks = (content) => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  };

  /* ── 工具：契约 / 证据 / 状态 / 核验 ── */

  const mkItem = (text, kind, seq) => ({ id: (kind === 'constraint' ? 'C' : 'R') + seq, text: String(text).trim(), kind, status: 'open', evidence: [] });

  const register = (tool) => ctx.tools.register(tool);

  register(defineTool({
    name: 'ledger_open',
    description: '登记任务契约：把用户的要求（requirements）与约束（constraints）逐条记入本会话账本，之后每次宣称完成都要逐条对照证据。任务开始时调用一次；追加要求时再调用。',
    parameters: {
      task: { type: 'string', description: '任务简报（用户最初的要求，可省略——缺省时用本会话首条用户消息）' },
      requirements: { type: 'array', items: { type: 'string' }, description: '逐条要求（每条一个字符串）' },
      constraints: { type: 'array', items: { type: 'string' }, description: '逐条约束（如「不改范围外代码」「不要动 X 文件」）' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    async execute(args, exec) {
      const session = sessionOf(exec);
      const key = keyOf(session, exec);
      return withLedgerLock(key, () => {
      const ledger = ensureLedger(key, session?.id, session?.header?.cwd);
      if (typeof args.task === 'string' && args.task.trim() !== '') ledger.taskBrief = args.task.trim();
      let seq = ledger.items.length;
      const added = [];
      for (const t of args.requirements ?? []) {
        if (typeof t !== 'string' || t.trim() === '') continue;
        seq += 1; const it = mkItem(t, 'requirement', seq); ledger.items.push(it); added.push(it);
      }
      for (const t of args.constraints ?? []) {
        if (typeof t !== 'string' || t.trim() === '') continue;
        seq += 1; const it = mkItem(t, 'constraint', seq); ledger.items.push(it); added.push(it);
      }
      writeLedger(key, ledger);
      const head = added.length > 0 ? `已登记 ${added.length} 条：\n${added.map((i) => `  ${i.id} ${i.text}`).join('\n')}` : '未新增条目（args 为空）。';
      const open = ledger.items.filter((i) => effectiveStatus(i) === 'open').length;
      return `${head}\n账本共 ${ledger.items.length} 条，其中 ${open} 条尚无证据。收尾前调用 ledger_check。${writeWarning(key)}`;
      });
    },
  }));

  register(defineTool({
    name: 'ledger_evidence',
    description: '给某条要求/约束挂证据。证据应指向真实发生的事：命令与其退出码、测试结果、文件行号、浏览器核验、URL 等。item 可传条目 id（R1/C2）或条目标题的唯一子串。',
    parameters: {
      item: { type: 'string', required: true, description: '条目 id（R1/C2）或标题的唯一子串' },
      kind: { type: 'string', required: true, description: '证据类型：command | test | file | browser | url | manual' },
      ref: { type: 'string', description: '证据引用（命令原文、文件:行、URL 等）' },
      note: { type: 'string', description: '补充说明（结论、退出码、观察到的值）' },
      status: { type: 'string', description: '顺带置状态：done（已确认完成）| dropped（明确不做）' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    async execute(args, exec) {
      const session = sessionOf(exec);
      const key = keyOf(session, exec);
      const needle = String(args.item ?? '').trim();
      // 只读取证先做完、**不进锁**：git 可能很慢（默认 10s 超时），把锁持在它身上会把
      // 每次工具调用的记账都挡住（实测慢 git 时 post-execute 被堵 2.8s），而 pre-step 也抢同一把锁。
      const ev = {
        at: Date.now(),
        kind: String(args.kind ?? 'manual'),
        ref: args.ref ? String(args.ref).slice(0, 500) : '',
        note: args.note ? String(args.note).slice(0, 500) : '',
      };
      let fileFactsDecisive = false;
      if (ev.kind === 'file' && gitEvidenceEnabled) {
        try {
          const gitFacts = await fileEvidenceFacts({ cwd: session?.header?.cwd ?? exec?.agent?.cwd, ref: ev.ref });
          ev.git = gitFacts;
          if (gitFacts?.ok === true) {
            // 文件确实存在且跟踪状态已查明：这就是客观取证，不必再看动作比对
            //（否则「改了文件但没跑命令」会被误判成自报证据）。
            const tracked = gitFacts.tracked === true ? '已被 git 跟踪' : gitFacts.tracked === false ? '未被 git 跟踪' : 'git 跟踪状态未知';
            const lineNote = gitFacts.lineInRange === false ? `；⚠️ 行号 ${gitFacts.line} 超出文件总行数 ${gitFacts.totalLines}` : '';
            fileFactsDecisive = gitFacts.lineInRange !== false;
            ev.verified = fileFactsDecisive;
            ev.reason = `只读 git 取证：文件存在（${gitFacts.bytes ?? '?'} 字节），${tracked}${lineNote}`;
          } else {
            ev.verified = false;
            ev.reason = gitFacts?.reason ?? '文件类证据未能取证';
            fileFactsDecisive = true;
          }
        } catch (err) {
          ev.git = { ok: false, reason: String(err?.message ?? err).slice(0, 160) };
        }
      }
      return withLedgerLock(key, async () => {
      const ledger = ensureLedger(key, session?.id, session?.header?.cwd);
      const lower = needle.toLowerCase();
      let target = ledger.items.find((i) => i.id.toLowerCase() === lower);
      if (!target) {
        const cands = ledger.items.filter((i) => i.text.toLowerCase().includes(lower));
        if (cands.length === 1) target = cands[0];
        else if (cands.length > 1) return `匹配到多条（${cands.map((i) => i.id).join(', ')}），请用条目 id 精确指定。`;
      }
      if (!target) return `没找到条目「${needle}」。先用 ledger_status 看现有条目。`;
      // 其余证据与「本会话已观察到的动作」（含日志重放）比对：自报证据不再与真证据长得一样。
      if (ev.verified === undefined && !fileFactsDecisive) {
        const facts = factsFor(session, ledger);
        const verdict = matchEvidence(ev, facts.activity, {
          factsAvailable: facts.replayAvailable,
          factsReason: facts.factsReason,
        });
        ev.verified = verdict.verified;
        ev.reason = verdict.reason;
      }
      target.evidence.push(ev);
      if (args.status === 'done' || args.status === 'dropped') target.status = args.status;
      writeLedger(key, ledger);
      const st = effectiveStatus(target);
      const open = ledger.items.filter((i) => effectiveStatus(i) === 'open').length;
      const mark = ev.verified === true ? '✅ 已被观察到的动作支撑' : ev.verified === null ? '📝 自述证据（不比对动作）' : '⚠️ 未观察到支撑动作';
      const gitLine = ev.git
        ? `\n   git 取证：${
            ev.git.ok === false
              ? `未通过（${ev.git.reason}）${ev.git.gitError ? `；git 查询失败：${ev.git.gitError}` : ''}`
              : `存在=${ev.git.exists}${ev.git.bytes !== null && ev.git.bytes !== undefined ? ` ${ev.git.bytes}B` : ''} · 被跟踪=${ev.git.tracked === null ? `未知（git 查询失败：${ev.git.gitError ?? '未说明'}）` : ev.git.tracked}${ev.git.lineInRange === false ? ` · ⚠️ 行号超出（文件共 ${ev.git.totalLines} 行）` : ''}`
          }`
        : '';
      const advice =
        ev.verified === false
          ? '\n   这条引用没有对应的已观察动作：要么真的跑一遍再挂证据，要么改用 kind=manual 并说明依据（如「人工核对」「上一步输出」）。'
          : '';
      audit({ event: 'evidence', session: key, item: target.id, kind: ev.kind, verified: ev.verified });
      return `${mark} · ${target.id} 已挂证据（${ev.kind}），状态=${st}${st === 'evidenced' && ev.verified === false ? '（但证据未被支撑，不算完成）' : ''}。\n   ${ev.reason ?? ''}${gitLine}${advice}\n剩余无证据条目：${open} 条。${writeWarning(key)}`;
      });
    },
  }));

  register(defineTool({
    name: 'ledger_status',
    description: '查看本会话账本全量：任务简报、每条要求/约束及其证据、以及最近被观察到的工具活动。压缩或恢复会话后也可用它确认要求没丢。',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    async execute(_args, exec) {
      const session = sessionOf(exec);
      const key = keyOf(session, exec);
      const ledger = readLedger(key);
      const issue = readIssues.get(key);
      if (!ledger) {
        return issue
          ? `本会话（${key}）的账本读取失败：${issue.reason}。已备份为 .corrupt-*，按空账本继续——请查清文件内容后再重建。`
          : `本会话（${key}）还没有账本。用 ledger_open 登记要求。`;
      }
      const out = [];
      out.push(`账本 ${key} · rev ${ledger.rev} · 更新于 ${new Date(ledger.updatedAt).toLocaleString()}`);
      if (ledger.taskBrief) out.push(`任务：${String(ledger.taskBrief).replace(/\s+/g, ' ').slice(0, 300)}`);
      if (ledger.items.length === 0) out.push('（无条目）');
      for (const it of ledger.items) {
        out.push(`${it.id} [${effectiveStatus(it)}] ${it.text}${it.evidence.length ? ` · ${it.evidence.length} 条证据` : ''}`);
        for (const ev of it.evidence.slice(-3)) out.push(`    - ${ev.kind}${ev.ref ? `: ${ev.ref}` : ''}${ev.note ? ` — ${ev.note}` : ''}`);
      }
      const facts = factsFor(session, ledger);
      const compat = await compatReport(session);
      out.push(
        `事实来源：会话日志重放 ${facts.replayed} 条 · 落盘 ${facts.persisted} 条 · 内存 ${facts.memory} 条（会话格式版本 ${compat.sessionFormatVersion ?? '未知'}，事件源 ${facts.eventsSource}）` +
          (facts.replayAvailable ? '' : ' ⚠️ 事件源不可用：现在无法比对证据，请勿据此判定「自报」'),
      );
      if (facts.activity.length > 0) {
        out.push('最近工具活动（重放/落盘优先，跨重启可核验）：');
        for (const a of facts.activity.slice(-8)) {
          const mark = a.ok === true ? '✓' : a.ok === false ? '✗' : '?';
          out.push(`    ${mark} ${a.name}${a.verifying ? ' [验证类]' : ''}${a.replayed ? ' [日志重放]' : ''}${a.ok === null ? ` [无法判定${a.okSource ? `:${a.okSource}` : ''}]` : ''}${a.detail ? ` — ${a.detail}` : a.note ? ` — ${a.note}` : ''}`);
        }
      }
      if (ledger.lastCheck) {
        const lc = ledger.lastCheck;
        out.push(`上次核验：${lc.verdict}（缺 ${lc.missing} 条，rev ${lc.rev}，${new Date(lc.at).toLocaleString()}）`);
      }
      const unv = unverifiedEvidenceOf(ledger, facts.activity, { factsAvailable: facts.replayAvailable, factsReason: facts.factsReason });
      if (unv.length > 0) out.push(`⚠️ 疑似自报证据：${unv.map((u) => `${u.id}(${u.kind})`).join(', ')}`);
      if (lastWriteError.has(key)) out.push(`⚠️ 上次写入账本失败：${lastWriteError.get(key).reason}`);
      if (readIssues.has(key)) out.push(`⚠️ 账本读取异常（已按空账本继续）：${readIssues.get(key).reason}`);
      return out.join('\n');
    },
  }));

  register(defineTool({
    name: 'ledger_check',
    description: '完成核验：对照账本逐条检查证据，返回 complete / incomplete 结论与缺口清单。**在向用户宣称「做完了」之前必须调用它**；返回 incomplete 时不得声称完成。',
    parameters: { claim: { type: 'string', description: '你打算宣称的完成结论（原文，便于留痕）' } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    async execute(args, exec) {
      const session = sessionOf(exec);
      const key = keyOf(session, exec);
      // 核验也要走同一把锁：这里是「读 → 重放算 → 整份写回」的读-改-写，
      // 不加锁就会把并发的记账 / 刚挂的证据覆盖掉（与 P1 修掉的是同一类丢失，只是换了入口）。
      return withLedgerLock(key, async () => {
      const ledger = readLedger(key) ?? emptyLedger(session?.id, session?.header?.cwd);
      const s = state(key);
      // 核验事实：日志重放优先（插件晚装/重启/分叉都不丢），落盘与内存只作补充。
      const facts = factsFor(session, ledger);
      const verdict = checkLedger(ledger, facts.activity, { strictEvidence, twoPhaseGate, twoPhaseForceEvidence });
      // 记下本次结论（不 bumpRev：核验本身不是契约变更，不该触发回注）。
      // `derived` 一起落盘：收尾门禁要能单列派生缺口（P2-3），否则只剩一个
      // 「还有 0 条没有证据（）」的空括号，模型永远不知道该补什么。
      ledger.lastCheck = {
        at: Date.now(),
        verdict: verdict.verdict,
        missing: verdict.missing,
        total: verdict.total,
        rev: ledger.rev ?? 0,
        strictEvidence,
        derived: verdict.derived.map((d) => ({ id: d.id, reason: d.reason })),
      };
      writeLedger(key, ledger, { bumpRev: false });
      audit({
        event: 'check', session: key, verdict: verdict.verdict, total: verdict.total, missing: verdict.missing,
        unverified: verdict.unverified.length, strictEvidence, replayed: facts.replayed,
      });
      // 交付报告（可选）：落到会话工作目录，作为可归档的交付物。
      let reportNote = '';
      if (reportFile !== '') {
        try {
          const cwd = session?.header?.cwd ?? s.cwd;
          const target = cwd ? join(cwd, reportFile) : reportFile;
          writeFileSync(target, renderReport(ledger, verdict, { at: Date.now(), key, cwd, replayed: facts.replayed, persisted: facts.persisted, memory: facts.memory }), 'utf8');
          reportNote = `\n交付报告已写入：${target}`;
        } catch (err) {
          reportNote = `\n⚠️ 交付报告写入失败：${String(err?.message ?? err).slice(0, 120)}`;
        }
      }
      const lines = [];
      lines.push(`verdict: ${verdict.verdict} · 共 ${verdict.total} 条 · 有证据 ${verdict.done} 条 · 缺证据 ${verdict.missing} 条`);
      lines.push(`事实来源：会话日志重放 ${facts.replayed} 条 · 落盘 ${facts.persisted} 条 · 内存 ${facts.memory} 条`);
      if (args.claim) lines.push(`拟宣称：${String(args.claim).slice(0, 300)}`);
      if (verdict.missing > 0) {
        lines.push('未满足（不得声称完成，需逐条补证据或明确说明未做）：');
        for (const m of verdict.missingItems) lines.push(`  ${m.id} ${m.text}${m.reason ? ` —— ${m.reason}` : ''}`);
      }
      if (verdict.doneItems.length > 0) {
        lines.push('已满足：');
        for (const d of verdict.doneItems) lines.push(`  ${d.id} ${d.text}（${d.evidence} 条证据，${d.status}）`);
      }
      if (verdict.unverified.length > 0) {
        lines.push(`未被动作支撑的证据 ${verdict.unverified.length} 条${strictEvidence ? '（已按 strictEvidence 降级为缺口）' : '（仅告警；strictEvidence=true 时算缺口）'}：`);
        for (const u of verdict.unverified) lines.push(`  ${u.id} ${u.kind}:${String(u.ref ?? '').slice(0, 80)} — ${u.reason}`);
      }
      for (const w of verdict.warnings) lines.push(`⚠️ ${w}`);
      if (verdict.verdict === 'complete') lines.push('可以宣称完成——但结论里要带上每条的证据出处。');
      return lines.join('\n') + reportNote + writeWarning(key);
      });
    },
  }));

  /**
   * 第五个工具（仅 `verify.enabled === true` 时注册）：跑一次验收命令。
   *
   * 与 `ledger_evidence` 的分工：那个是「我相信我跑过」，这个是「插件替你跑、只认退出码」。
   * 命令只能引用 `verify.commands` 里的 id（见 `resolveVerifyCommand`）。
   */
  if (verifyEnabled) {
    register(defineTool({
      name: 'ledger_verify',
      description: '执行某条契约的验收命令（由插件自己跑，只认退出码 0），把结果作为客观证据挂到条目上。通过后条目变成「有证据」；不通过会返回失败输出尾部，按它继续修。',
      parameters: {
        item: { type: 'string', required: true, description: '条目 id（R1/C2）或标题唯一子串' },
        command: { type: 'string', required: true, description: '验收命令 id（verify.commands 里声明的 id）' },
        commit: { type: 'boolean', description: 'true = 把该命令登记到条目上，收尾时自动重跑（受预算限制）' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
      async execute(args, exec) {
        const session = sessionOf(exec);
        const key = keyOf(session, exec);
        const needle = String(args.item ?? '').trim();
        const resolved = resolveVerifyCommand(args.command);
        if (!resolved.ok) return resolved.reason;
        const cwd = session?.header?.cwd ?? exec?.agent?.cwd;
        if (!cwd) return '没有会话工作目录，拒绝在没有 cwd 的地方执行验收命令（否则会在插件进程的 cwd 下跑）。';
        // 先在锁内定位条目（并可选登记命令 id）→ 锁外跑命令（可能几分钟）→ 锁内重读再挂证据。
        // 不把整段执行放进锁里：跑 120s 会挡住所有记账写入。
        let itemId = null;
        await withLedgerLock(key, () => {
          const ledger = ensureLedger(key, session?.id, cwd);
          const lower = needle.toLowerCase();
          let target = ledger.items.find((i) => i.id.toLowerCase() === lower);
          if (!target) {
            const cands = ledger.items.filter((i) => i.text.toLowerCase().includes(lower));
            if (cands.length === 1) target = cands[0];
          }
          if (!target) return false;
          itemId = target.id;
          if (args.commit === true && resolved.id) {
            target.verify = resolved.id;
            writeLedger(key, ledger);
          }
          return true;
        });
        if (!itemId) return `没找到条目「${needle}」。先用 ledger_status 看现有条目。`;
        const result = await runOracle(resolved.command, { cwd, timeoutMs: verifyTimeout, tailChars: verifyTail, signal: exec?.signal, env: oracleSessionEnv(session, key) });
        const attached = await attachOracleEvidence(key, itemId, resolved.id, resolved.command, result);
        audit({ event: 'oracle', session: key, item: itemId, commandId: resolved.id, ok: result.ok, exitCode: result.exitCode, timedOut: result.timedOut, durationMs: result.durationMs });
        const body = renderOracleResult({ itemId, command: resolved.command, result, limit: verifyTail });
        return `${body}\n${attached
          ? `已作为客观证据挂到条目上（verified=${result.ok === true}）。`
          : '⚠️ 证据没有落盘，不要据此宣称完成。'}${writeWarning(key)}`;
      },
    }));
  }

  /* ── 系统提示段：只在有账本时出现 ── */

  if (config.registerSection ?? true) {
    try {
      ctx.systemPrompt?.section?.({
        name: 'completion-ledger:discipline',
        order: 90,
        text: () => '收尾纪律（任务契约账本）：把用户的要求与约束用 ledger_open 逐条登记；每条都要有真实证据（ledger_evidence）；**在宣称完成之前必须调用 ledger_check**，返回 incomplete 时不要声称完成，而要说明还差什么。',
      });
    } catch (err) {
      ctx.logger?.warn?.(`completion-ledger: 注册系统提示段失败 ${String(err)}`);
    }
  }

  /* ── 接缝零：新建 / 恢复 / 压缩重建会话 → 下一次 pre-step 必须回注一次 ── */

  try {
    ctx.on('agent/created', (payload) => {
      try {
        const session = payload?.agent?.session;
        const key = sessionKeyOf(session?.id, session?.header?.cwd);
        const s = state(key);
        const src = String(payload?.source ?? 'startup');
        // compact 时宿主重建了 agent，压缩计数的基线就归零了 —— 靠 forceReinject 保证仍能注入一次；
        // startup/resume 时插件可能在账本已存在之后才被加载（重启后恢复会话），也要补一次，
        // 否则「恢复一个从未压缩过的会话」会静默缺席整份账本。
        s.compactions = 0;
        s.startSource = src;
        s.verifySteers = 0;
        if (src === 'startup' || src === 'resume' || src === 'compact') s.forceReinject = true;
      } catch (err) {
        ctx.logger?.warn?.(`completion-ledger: 处理 agent/created 失败 ${String(err)}`);
      }
    });
  } catch (err) {
    // 旧宿主没有这个事件：不是错误，回注照旧靠压缩/账本变化触发。
    ctx.logger?.debug?.(`completion-ledger: 宿主未提供 agent/created ${String(err)}`);
  }

  /* ── 接缝一：压缩后回注（agent/pre-step） ── */

  ctx.on('agent/pre-step', async (payload, next) => {
    let decision;
    try {
      decision = await next();
    } catch {
      return next();
    }
    try {
      if (decision?.kind !== 'enter') return decision;
      const session = payload?.agent?.session;
      const key = sessionKeyOf(session?.id, session?.header?.cwd);
      const s = state(key);
      s.turns += 1;

      // 首轮：把用户原话记为任务简报（不解析、不改写）
      if ((config.autoCaptureBrief ?? true) && !s.briefed) {
        s.briefed = true;
        await withLedgerLock(key, () => {
          const ledger0 = readLedger(key) ?? emptyLedger(session?.id, session?.header?.cwd);
          if (!ledger0.taskBrief) {
            const firstUser = (decision.messages ?? []).find((m) => m?.role === 'user');
            const text = textOfBlocks(firstUser?.content).trim();
            if (text !== '') {
              ledger0.taskBrief = text.slice(0, 1200);
              writeLedger(key, ledger0);
            }
          } else {
            s.rev = ledger0.rev;
          }
        });
      }

      const ledger = readLedger(key);
      if (!ledger) return decision;

      // 收尾门禁的降级路径：宿主不提供 agent.inject 时，把上轮那条提醒在此补上。
      if (s.gateFallback) {
        const text = s.gateFallback;
        s.gateFallback = null;
        ctx.logger?.info?.('completion-ledger: 补投上一轮的收尾门禁提醒');
        return { ...decision, messages: [...decision.messages, gateMessage(text)] };
      }

      const compactions = compactionCount(session);
      const compacted = compactions > s.compactions;
      const changed = (ledger.rev ?? 0) !== s.rev;
      const everyN = Number(config.reinjectEveryTurns ?? 0);
      const dueTick = everyN > 0 && s.turns % everyN === 0;
      // agent/created 明确说过「这是新建/恢复/压缩重建的会话」时，即使压缩计数没变也要注入一次
      // （否则重启后恢复一个从未压缩过的会话，账本会静默缺席，直到下一次账本变化）。
      const forced = s.forceReinject === true;
      if (!compacted && !changed && !dueTick && !forced) return decision;

      s.compactions = compactions;
      s.rev = ledger.rev ?? 0;
      s.injected += 1;
      s.forceReinject = false;

      const note = renderNote(ledger, { maxNoteChars });
      const why = forced
        ? `会话开始（${s.startSource ?? 'startup'}）`
        : compacted ? '检测到会话压缩' : changed ? '账本有更新' : `每 ${everyN} 轮例行`;
      const message = reinjectMessage(why, note);
      ctx.logger?.info?.(`completion-ledger: 回注账本（${why}，${note.length} 字符）`);
      return { ...decision, messages: [...decision.messages, message] };
    } catch (err) {
      ctx.logger?.warn?.(`completion-ledger: 回注失败 ${String(err)}`);
      return decision;
    }
  }, { prepend: true });

  /* ── 接缝四：写入门禁（账本自身不可被工具改写） ── */

  // 只拦「账本自己被改」这一件事，**刻意不拦 tests / CI**：改测试在正常开发里是本职
  // （pua 的 integrity-guard 把 tests 全列 deny，开了就走不动路）。
  //
  // 边界要说清：这是**减速带，不是安全边界**。`run_code` 能算路径、bash 能拼变量、
  // `node -e` 能 `homedir()+'/...'`——任何字符串匹配都拦不住这些。真正管用的是
  // 「账本由插件自己维护」这个约定 + 核验时重算证据，而不是这道正则。
  // 写工具清单（WRITE_TOOLS / SHELL_TOOLS）与写特征表（shellMutationOf / stripRedirectNoise）
  // 都来自 `./write-signals.js`——派生闸门用同一份，改一处两边同步，不会漂移。
  /** realpath 最近**已存在**的祖先，再把剩余部分拼回去：目标文件还不存在时也能解析目录符号链接。 */
  const realOf = (p) => {
    let cur = p;
    for (let i = 0; i < 40; i += 1) {
      try {
        const realCur = realpathSync(cur);
        return cur === p ? realCur : join(realCur, relative(cur, p));
      } catch {
        const up = dirname(cur);
        if (up === cur) return p;
        cur = up;
      }
    }
    return p;
  };
  /** 路径是否落在账本目录内：解析 + realpath（含祖先），挡相对路径与符号链接。 */
  const insideLedgerDir = (rawPath, cwd) => {
    if (typeof rawPath !== 'string' || rawPath === '' || !dir) return false;
    // macOS 上 /var 是 /private/var 的符号链接：基准目录本身也要归一化，
    // 否则「同一目录」会被判成两个（实测因此漏拦符号链接用例）。
    const base = realOf(resolve(dir));
    const within = (p) => {
      const rel = relative(base, p);
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    };
    try {
      const abs = resolve(cwd || process.cwd(), rawPath);
      return within(abs) || within(realOf(abs));
    } catch {
      return false;
    }
  };
  /** 从补丁正文里抽目标路径：`apply_patch` 这类工具的目标只写在正文里，没有 path 字段。 */
  const patchTargets = (argsObj) => {
    const text = String(argsObj?.patch ?? argsObj?.input ?? argsObj?.content ?? '');
    const out = [];
    for (const m of text.matchAll(/\*\*\*\s*(?:Add|Update|Delete)\s+File:\s*(.+)/g)) out.push(m[1].trim());
    return out;
  };
  /** 文本里是否提到某路径——必须卡**路径边界**，否则 `completion-ledger-backup/a.json` 会误中。 */
  const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mentionsPath = (text, target) => {
    if (!text || !target) return false;
    try {
      return new RegExp(`${escapeRe(target)}(?![\\w.-])`).test(text);
    } catch {
      return false;
    }
  };

  try {
    ctx.on('tools/pre-execute', async (exec, next) => {
      // next() 必须在 try 内：否则任一前置监听器抛错，本 handler 也跟着 reject，
      // 工具调用会被记在插件头上（���妹监听器 pre-step 是这么写的，这里保持一致）。
      try {
        const decision = await next();
        if (decision?.kind === 'deny') return decision;
        const name = String(exec?.name ?? '');
        if (!WRITE_TOOLS.test(name)) return decision;
        const argsObj = exec?.arguments ?? exec?.args ?? null;
        const cwd = exec?.agent?.session?.header?.cwd ?? exec?.agent?.cwd;
        // ① 文件类工具：按**路径**判（解析 + realpath），不做字符串包含。
        const declaredPath = typeof argsObj?.path === 'string'
          ? argsObj.path
          : typeof argsObj?.file_path === 'string' ? argsObj.file_path : '';
        let hit = insideLedgerDir(declaredPath, cwd);
        // 补丁类工具的目标写在正文里（没有 path 字段），必须从 `*** Update File:` 抽出来，
        // 否则「模型自己改账本给自己发证据」这条路是通的（第三轮验收实测的 X1）。
        if (!hit && /^(apply_patch|multi_edit)$/i.test(name)) {
          hit = patchTargets(argsObj).some((p) => insideLedgerDir(p, cwd));
        }
        if (!hit && SHELL_TOOLS.test(name)) {
          // 只有 shell / run_code 才退回文本判定（它们把路径写在 command 里）：
          // 文件类工具的正文可能**提到**账本路径（比如写文档），拿文本判会误拦。
          // 判定前先剔除无害重定向与箭头函数（`=>` 里的 `>` 不是重定向），
          // 且「有没有真的写文件」由 write-signals.js 统一判：`> /dev/null` 不算写、
          // `git apply --check` 只检查不落地——旧版这里一条 `>>?` 全当写，误拦只读命令。
          const stripped = stripArrows(stripRedirectNoise(String(detailOfArguments(argsObj, { full: true }) ?? '')));
          if (mentionsPath(stripped, resolve(dir)) || mentionsPath(stripped, dir)) {
            // 门禁这里必须**保守**：引号内的重定向也算写。
            // `perl -e 'open(F,">","<账本>")'` / `awk 'BEGIN{print "{}" > "<账本>"}'`
            // 的 `>` 落在引号里，闸门侧按「引号内多半是比较运算」跳过是对的，
            // 但门禁侧路径已被 mentionsPath 精确锁定，多判无害、漏判可被利用
            // （2026-11-11 第 2 轮评审实测：共用默认参数会削弱这道门禁）。
            hit = shellMutationOf(stripped, { quotedRedirects: true });
          }
        }
        if (!hit) return decision;
        const reason =
          'completion-ledger: 账本文件由插件自己维护，不允许通过工具改写'
          + '（否则「完成核验」可以自己给自己发证据）。修正账本请用 ledger_open / ledger_evidence / ledger_check。';
        const session = exec?.agent?.session;
        audit({ event: 'guard-deny', session: sessionKeyOf(session?.id, session?.header?.cwd), tool: name });
        ctx.logger?.info?.(`completion-ledger: 拦下对账本的写入（${name}）`);
        return { kind: 'deny', reason };
      } catch (err) {
        ctx.logger?.warn?.(`completion-ledger: 写入门禁失败，放行 ${String(err)}`);
        return { kind: 'allow' };
      }
    });
  } catch (err) {
    // 旧宿主没有这个接缝：不是错误，只是少了一道保护。
    ctx.logger?.debug?.(`completion-ledger: 宿主未提供 tools/pre-execute ${String(err)}`);
  }

  /* ── 接缝二：观察工具活动（仅内存，供核验参考） ── */

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next();
    try {
      const session = sessionOf(exec);
      const key = keyOf(session, exec);
      const s = state(key);
      // ok 是三态，且必须看执行结果：只看 decision.kind 会把「抛错的工具」记成成功，
      // 于是同一动作在内存通道是 ✓、在重放通道是 ✗（replay 用 exitCode/错误文本推三态）。
      const ok = decision?.kind === 'block' || result?.isError === true
        ? false
        : decision?.kind === 'accept' ? true : null;
      const name = String(exec?.name ?? '?');
      let note = '';
      try {
        if (decision?.kind === 'accept') {
          const blocks = decision.content ?? decision.value?.content;
          const text = textOfBlocks(blocks);
          if (text) note = text.replace(/\s+/g, ' ').slice(0, 100);
        } else if (decision?.reason) {
          note = String(decision.reason).replace(/\s+/g, ' ').slice(0, 100);
        }
      } catch { /* 摘要尽力而为 */ }
      // detail 存「这次动作做了什么」（命令原文/参数），否则无法把证据引用与动作对上。
      // 宿主字段名是 `arguments`（不是 args/input）：读错名字会让这里的 detail **恒为空**，
      // 实测本机 19/19 条活动都是空串，证据比对全靠会话日志重放兜着。
      // 同时保留 detailFull（不截断，供指纹比对），detail 只用于展示。
      let detail = '';
      let detailFull = '';
      try {
        const rawArgs = exec?.arguments ?? exec?.args ?? exec?.input ?? null;
        // 4000 字符上限：write 类工具的 arguments 可能包含整个文件内容，不设限会把账本撑爆。
        detailFull = String(detailOfArguments(rawArgs, { full: true }) ?? '').slice(0, 4000);
        detail = detailFull.slice(0, 200);
      } catch { /* 参数不可序列化时留空 */ }
      const callId = exec?.callId ?? exec?.toolCallId ?? null;
      const at = Date.now();
      const entry = {
        at,
        name,
        ok,
        detail,
        detailFull,
        note,
        verifying: /^(bash|run_code|lint_|browser_|test|tracescope_)/.test(name),
        callId,
        key: entryKey({ callId, name, detail: detailFull || detail, at }),
      };
      s.activity.push(entry);
      if (s.activity.length > activityLimit) s.activity.splice(0, s.activity.length - activityLimit);
      await appendActivity(key, entry);
    } catch { /* 观察失败不影响调用 */ }
    return decision;
  });

  /* ── 接缝三：收尾门禁（本轮要结束而账本未收口 → 注入一条提醒） ── */

  ctx.on('agent/turn-stopping', async (payload) => {
    // gateOnStop: off 只关「提醒」，不该把验收驱动一起关掉——那是两件事：
    // 提醒是唠叨，Oracle 是「跑一遍命令再决定能不能收工」。
    if (gateMode === 'off' && !verifyEnabled) return;
    try {
      const agent = payload?.agent;
      const session = agent?.session;
      if (!session) return;
      const key = sessionKeyOf(session?.id, session?.header?.cwd);
      const ledger = readLedger(key);
      if (!ledger) return;
      const live = liveItems(ledger);
      if (live.length === 0) return;
      const s = state(key);
      // payload.turn 缺失时**不能**拿 s.turns 顶替：s.turns 每个 step 都 +1，
      // 于是每次 steer 之后再进来预算又被重置，maxSteersPerTurn 形同虚设（实测 4 次 steer）。
      // 拿不到宿主轮次就退化成「会话级总额」，由 maxSteersPerSession 兜底。
      const hostTurn = typeof payload?.turn === 'number' ? payload.turn : null;
      const turn = hostTurn ?? s.turns;
      if (hostTurn !== null && s.steerTurn !== hostTurn) {
        s.steerTurn = hostTurn;
        s.verifySteers = 0;
      }

      // P3：声明了验收命令的条目，到收尾边界由**插件自己**跑一次（只认退出码）。
      // 不通过 → 把输出当数据回灌 + steer 驱动下一步；受 maxSteersPerTurn 限制，避免死循环。
      //
      // **必须在 settled 判定之前**：失败的 Oracle 会挂一条 verified:false 的证据，条目因此变成
      // 「evidenced」，settled 就会成立并提前 return —— 驱动循环还没开始就被掐死（实测踩到）。
      if (verifyEnabled) {
        const budget = Math.min(
          Math.max(0, verifyMaxSteers - (s.verifySteers ?? 0)),
          Math.max(0, verifyMaxSession - (s.verifySession ?? 0)),
        );
        const targets = pendingVerifyTargets(ledger, {
          budgetLeft: budget,
          commandIds: verifyCommands.map((c) => c.id),
          // 默认命令已在装配时按 commands 白名单过滤过；这里再兜一层由 loop 自己判 declared。
          defaultCommandIds: verifyDefaultCommands,
        });
        if (targets.length > 0) {
          const cwd = session?.header?.cwd ?? agent?.cwd;
          const results = [];
          for (const t of targets) {
            const declared = verifyCommands.find((c) => c.id === t.commandId);
            if (!declared) continue;
            const res = await runOracle(declared.command, { cwd, timeoutMs: verifyTimeout, tailChars: verifyTail, signal: payload?.signal, env: oracleSessionEnv(session, key) });
            await attachOracleEvidence(key, t.itemId, t.commandId, declared.command, res);
            audit({ event: 'oracle', session: key, item: t.itemId, commandId: t.commandId, ok: res.ok, exitCode: res.exitCode, timedOut: res.timedOut, durationMs: res.durationMs });
            results.push({ ...t, command: declared.command, result: res });
          }
          const failed = results.filter((r) => r.result?.ok !== true);
          if (failed.length > 0) {
            s.verifySteers = (s.verifySteers ?? 0) + 1;
            s.verifySession = (s.verifySession ?? 0) + 1;
            const text = failed
              .map((f) => renderOracleResult({ itemId: f.itemId, command: f.command, result: f.result, limit: verifyTail }))
              .join('\n\n');
            if (typeof agent.steer === 'function') {
              try {
                agent.steer(gateMessage(text));
              } catch (err) {
                ctx.logger?.warn?.(`completion-ledger: Oracle 未通过，steer 失败 ${String(err)}`);
              }
            }
            ctx.logger?.info?.(`completion-ledger: Oracle 未通过（${failed.length} 条），已驱动下一步（第 ${s.verifySteers}/${verifyMaxSteers} 次）`);
            return;
          }
          // 通过之后**不要 return**：一条验收通过 ≠ 整个账本收口，其它条目可能还没有证据，
          // 收尾门禁仍要提醒（否则「跑通一条」就把「还有 N 条没证据」整轮静音了）。
          if (results.length > 0) {
            ctx.logger?.info?.(`completion-ledger: Oracle 全部通过（${results.length} 条），证据已挂`);
          }
        }
      }

      const open = live.filter((it) => effectiveStatus(it) === 'open');
      const lc = ledger.lastCheck;
      const checkedAtCurrentRev = lc !== undefined && lc !== null && (lc.rev ?? -1) === (ledger.rev ?? 0);
      const settled = open.length === 0 && checkedAtCurrentRev && lc.verdict === 'complete';
      if (settled) return;
      // gateOnStop: off 只关**提醒**：验收驱动在上面已经跑过了，走到这里就要止步
      // （否则用户设了 off，仍然会收到「用 gateOnStop: off 可关闭」的提醒）。
      if (gateMode === 'off') return;

      // 一轮最多提醒一次；但宿主不给 turn 时不能拿 s.turns 当轮次（它每个 step 都 +1），
      // 改用会话级上限兜底，否则每轮都会白烧一个模型步。
      if (hostTurn !== null && s.gateNotifiedTurn === hostTurn) return;
      if ((s.remindCount ?? 0) >= 20) return;
      // 本轮啥也没干（没有观察到任何工具活动）就别唠叨：账本开着但只是闲聊。
      const persistedActivity = Array.isArray(ledger.activity) ? ledger.activity : [];
      if (persistedActivity.length === 0 && s.activity.length === 0) return;
      if (hostTurn !== null) s.gateNotifiedTurn = hostTurn;
      s.remindCount = (s.remindCount ?? 0) + 1;
      // 缺口必须把**派生缺口**算进去（P2-3）：`settled` 要求 verdict=complete，而派生缺口
      // 会影响 verdict；但计数与 id 列表原先只看「open 条目」，于是条目全有证据、只剩派生
      // 缺口时模型收到「还有 0 条没有证据（）」——空括号、计数 0，补证据也永远收不了口。
      const derivedGaps = checkedAtCurrentRev && Array.isArray(lc.derived) ? lc.derived : [];
      const missing = open.length + derivedGaps.length;
      const openIds = [
        ...open.slice(0, 8).map((it) => it.id),
        ...derivedGaps.map((d) => `派生:${d.id}`),
      ].join(', ') + (open.length > 8 ? ' …' : '');
      const derivedDetail = derivedGaps.map((d) => `  · 派生:${d.id} — ${d.reason}`).join('\n');
      const why = checkedAtCurrentRev
        ? `上次核验是 ${lc.verdict}（缺 ${lc.missing} 条）`
        : '本轮还没有对账本做过核验';
      const text =
        `[完成门禁] 本轮即将结束，但任务契约账本还没收口：${why}；当前 ${live.length} 条契约里还有 ${missing} 条没有证据（${openIds}）。\n` +
        (derivedDetail === '' ? '' : `${derivedDetail}\n`) +
        '· 如果确实已经做完 → 先调 ledger_check 拿到 verdict，再对外宣称完成；\n' +
        '· 如果还差东西 → 直接说明还差哪几条，不要用「已完成」结束本轮。\n' +
        '（本条会把你拉回一步继续收口，而不是等你下一句话；用 gateOnStop: off 可关闭。）';
      // 驱动方式：这里必须用 steer，而不是 inject。
      //   steer → 写入 inbox，宿主在本轮结束判定处再读一次 inbox，于是**同一 turn 内再跑一步**；
      //   inject → 只往 inbox 排队、不唤醒 driver；是否继续本轮取决于宿主 loop 的 break 条件
      //            （本宿主只看 nextStep 是否为空，所以恰好也会继续 —— 但这是实现细节，不是契约）。
      //   steer  → 宿主文档指定的「监听器反对」手段，且会 wakeDriver（空闲时也能起一轮）。
      let drive = 'none';
      if (typeof agent.steer === 'function') {
        try {
          agent.steer(gateMessage(text));
          drive = 'steered';
        } catch (err) {
          ctx.logger?.warn?.(`completion-ledger: 收尾门禁 steer 失败 ${String(err)}`);
        }
      }
      if (drive === 'none' && typeof agent.inject === 'function') {
        try {
          agent.inject(gateMessage(text));
          drive = 'queued';
        } catch (err) {
          ctx.logger?.warn?.(`completion-ledger: 收尾门禁 inject 失败，降级到下一轮回注 ${String(err)}`);
        }
      }
      if (drive === 'none') s.gateFallback = text; // 宿主两种手段都没有时，下一次 pre-step 补上
      audit({ event: 'gate', session: key, turn, drive, injected: drive !== 'none', open: missing, live: live.length, why });
      ctx.logger?.info?.(`completion-ledger: 收尾门禁触发（缺 ${missing} 条，drive=${drive}）`);
    } catch (err) {
      ctx.logger?.warn?.(`completion-ledger: 收尾门禁失败 ${String(err)}`);
    }
  });
}

export default { name, inject, Config, apply };
