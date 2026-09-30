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
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import z from '@deepseek-ai/schemastery';
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { compatReport, eventsInfo, eventsOf } from './compat/index.js';
import { entryKey, mergeActivity, replayActivity } from './replay.js';
import { fileEvidenceFacts } from './git-evidence.js';

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
 * 把一条证据与「已观察到的工具活动」比对。
 *
 * 语义边界（刻意保守，避免把真证据判成假的）：
 * - `kind: 'manual'` 是自述证据，**不参与**动作比对 → `verified: null`；
 * - 抽不出指纹词（引用为空/全是停用词）→ `verified: false`（无法核验）；
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
  const pool = (Array.isArray(activity) ? activity : []).filter(
    // 元动作不算「做过这件事」：ledger_* 调用（含它自己的参数文本）不该支撑任何证据。
    (a) => Number(a?.at ?? 0) <= at + 1000 && !/^ledger_/.test(String(a?.name ?? '')),
  );
  if (pool.length === 0 && !factsAvailable) {
    return { verified: null, reason: `事实不可得（${opts.factsReason ?? '读不到会话日志'}），未做比对——不能据此认定自报` };
  }
  let best = null;
  for (const a of pool) {
    // 指纹池只用「动作本身」（工具名 + 参数）：工具**输出文本**里出现同名字符串不算做了这件事。
    const hay = `${a?.name ?? ''} ${a?.detail ?? ''}`.toLowerCase();
    const hit = tokens.filter((t) => hay.includes(t)).length;
    if (best === null || hit > best.hit) best = { hit, a };
    if (hit === tokens.length) break;
  }
  const ratio = best ? best.hit / tokens.length : 0;
  if (best && ratio >= 0.6) {
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
export function unverifiedEvidenceOf(ledger, activity = [], opts = {}) {
  const out = [];
  for (const it of liveItems(ledger)) {
    for (const ev of it.evidence ?? []) {
      // 判定怎么来的，决定要不要重算：
      //  - 动作类（command/test/browser/url）：**每次核验都重算**。事实来自会话日志，而日志只会变多，
      //    匹配器也会随版本变准；沿用旧的 false 会把「当时窗口太窄」永久钉成「自报」。
      //  - manual / file：判定来自自述或客观取证，不重算（file 的 git 事实不会因新动作而改变）。
      const actionMatched = ev.kind !== 'manual' && ev.kind !== 'file';
      const verdict = actionMatched || ev.verified === undefined
        ? matchEvidence(ev, activity, opts)
        : { verified: ev.verified, reason: ev.reason };
      if (verdict.verified === false) out.push({ id: it.id, text: it.text, kind: ev.kind, ref: ev.ref, reason: verdict.reason });
    }
  }
  return out;
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
  const unverified = unverifiedEvidenceOf(ledger, activity, opts);
  const downgraded = [];
  if (strict && unverified.length > 0) {
    // 严格模式：拿不出证据的降级为「未完成」，从已满足里移出。
    const ids = new Set(unverified.map((u) => u.id));
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
  if (items.length === 0) warnings.push('账本为空：先用 ledger_open 记录要求，否则核验没有依据。');
  return {
    verdict: items.length === 0 ? 'empty' : missing.length === 0 ? 'complete' : 'incomplete',
    total: items.length, done: done.length, missing: missing.length,
    missingItems: missing.map((it) => ({ id: it.id, text: it.text, evidence: it.evidence?.length ?? 0 })),
    doneItems: done.map((it) => ({ id: it.id, text: it.text, evidence: it.evidence?.length ?? 0, status: effectiveStatus(it) })),
    unverified,
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
 * 门禁只**提醒**不否决：宿主文档写明 `agent/turn-stopping` 的 `Stop` 是串行监听、
 * 阻断结果会用 `steer()` 强制再来一步——也就是说这个接缝**能**拦。本插件刻意只做提醒
 * （不替用户决定要不要收工），硬拦留给工具的 pre-execute。
 *
 * @param text - 面向模型的提醒正文。
 * @returns 冻结的 user 消息；交给 `agent.inject(...)` 或下一次 `decision.messages`。
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
  const gateMode = config.gateOnStop ?? 'remind';
  const auditEnabled = config.audit ?? true;
  const replayEnabled = config.replayFromSessionLog ?? true;
  const replayMaxEntries = Math.max(persistedLimit, Number(config.replayMaxEntries) || 2000);
  const gitEvidenceEnabled = config.gitEvidence ?? true;
  const reportFile = String(config.reportFile ?? '').trim();
  const sessions = new Map();

  const state = (key) => {
    let s = sessions.get(key);
    if (!s) {
      s = { key, compactions: 0, rev: -1, injected: 0, turns: 0, activity: [], briefed: false, gateNotifiedTurn: null, gateFallback: null };
      sessions.set(key, s);
    }
    return s;
  };

  const readLedger = (key) => {
    try {
      const p = ledgerPath(dir, key);
      if (!existsSync(p)) return null;
      const parsed = JSON.parse(readFileSync(p, 'utf8'));
      if (!parsed || typeof parsed !== 'object') return null;
      if (!Array.isArray(parsed.items)) parsed.items = [];
      return parsed;
    } catch {
      return null;
    }
  };

  /**
   * 写账本。
   *
   * `bumpRev: false` 用于「记账但不改变契约」的旁路写入（工具活动、上次核验结论）：
   * rev 是回注的触发条件（`agent/pre-step` 里比对 `ledger.rev !== s.rev`），
   * 若每次工具调用都 +1，就会变成每轮都回注一次账本——噪音。
   */
  const writeLedger = (key, ledger, { bumpRev = true } = {}) => {
    try {
      mkdirSync(dir, { recursive: true });
      if (bumpRev) ledger.rev = (ledger.rev ?? 0) + 1;
      ledger.updatedAt = Date.now();
      writeFileSync(ledgerPath(dir, key), JSON.stringify(ledger, null, 1), 'utf8');
      const s = state(key);
      if (bumpRev) s.rev = ledger.rev;
      return true;
    } catch (err) {
      ctx.logger?.warn?.(`completion-ledger: 写入账本失败 ${String(err)}`);
      return false;
    }
  };

  /** 审计 JSONL：一行一件事，供事后回看「插件到底干活了没」。 */
  const audit = (event) => {
    if (!auditEnabled) return;
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, 'audit.jsonl'), `${JSON.stringify({ at: Date.now(), ...event })}\n`, 'utf8');
    } catch { /* 审计尽力而为，绝不影响主流程 */ }
  };

  /** 只对**已有账本**的会话记录工具活动（不因为一次工具调用就凭空造出账本）。 */
  const appendActivity = (key, entry) => {
    try {
      const ledger = readLedger(key);
      if (!ledger) return;
      ledger.activity = recordActivity(ledger.activity, entry, persistedLimit);
      writeLedger(key, ledger, { bumpRev: false });
    } catch { /* 记账失败不影响工具调用 */ }
  };

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

  /** 统计会话事件里的压缩次数（snapshotEvents 是 rc.1+ 的公开 API）。 */
  const compactionCount = (session) => {
    try {
      const evs = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : session?.events ?? [];
      if (!Array.isArray(evs)) return 0;
      let n = 0;
      for (const e of evs) if (typeof e?.type === 'string' && e.type.startsWith('compaction/')) n += 1;
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
      return `${head}\n账本共 ${ledger.items.length} 条，其中 ${open} 条尚无证据。收尾前调用 ledger_check。`;
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
      const ledger = ensureLedger(key, session?.id, session?.header?.cwd);
      const needle = String(args.item ?? '').trim();
      const lower = needle.toLowerCase();
      let target = ledger.items.find((i) => i.id.toLowerCase() === lower);
      if (!target) {
        const cands = ledger.items.filter((i) => i.text.toLowerCase().includes(lower));
        if (cands.length === 1) target = cands[0];
        else if (cands.length > 1) return `匹配到多条（${cands.map((i) => i.id).join(', ')}），请用条目 id 精确指定。`;
      }
      if (!target) return `没找到条目「${needle}」。先用 ledger_status 看现有条目。`;
      const ev = {
        at: Date.now(),
        kind: String(args.kind ?? 'manual'),
        ref: args.ref ? String(args.ref).slice(0, 500) : '',
        note: args.note ? String(args.note).slice(0, 500) : '',
      };
      // 文件类证据：先取客观事实（存在性 / 是否被 git 跟踪），再决定它算不算证据。
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
      return `${mark} · ${target.id} 已挂证据（${ev.kind}），状态=${st}。\n   ${ev.reason ?? ''}${gitLine}${advice}\n剩余无证据条目：${open} 条。`;
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
      if (!ledger) return `本会话（${key}）还没有账本。用 ledger_open 登记要求。`;
      const s = state(key);
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
      const ledger = readLedger(key) ?? emptyLedger(session?.id, session?.header?.cwd);
      const s = state(key);
      // 核验事实：日志重放优先（插件晚装/重启/分叉都不丢），落盘与内存只作补充。
      const facts = factsFor(session, ledger);
      const verdict = checkLedger(ledger, facts.activity, { strictEvidence });
      // 记下本次结论（不 bumpRev：核验本身不是契约变更，不该触发回注）。
      ledger.lastCheck = { at: Date.now(), verdict: verdict.verdict, missing: verdict.missing, total: verdict.total, rev: ledger.rev ?? 0, strictEvidence };
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
        for (const m of verdict.missingItems) lines.push(`  ${m.id} ${m.text}`);
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
      return lines.join('\n') + reportNote;
    },
  }));

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
      if (!compacted && !changed && !dueTick) return decision;

      s.compactions = compactions;
      s.rev = ledger.rev ?? 0;
      s.injected += 1;

      const note = renderNote(ledger, { maxNoteChars });
      const why = compacted ? '检测到会话压缩' : changed ? '账本有更新' : `每 ${everyN} 轮例行`;
      const message = reinjectMessage(why, note);
      ctx.logger?.info?.(`completion-ledger: 回注账本（${why}，${note.length} 字符）`);
      return { ...decision, messages: [...decision.messages, message] };
    } catch (err) {
      ctx.logger?.warn?.(`completion-ledger: 回注失败 ${String(err)}`);
      return decision;
    }
  }, { prepend: true });

  /* ── 接缝二：观察工具活动（仅内存，供核验参考） ── */

  ctx.on('tools/post-execute', async (exec, _result, next) => {
    const decision = await next();
    try {
      const session = sessionOf(exec);
      const key = keyOf(session, exec);
      const s = state(key);
      const ok = decision?.kind === 'accept';
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
      let detail = '';
      try {
        const args = exec?.args ?? exec?.input ?? null;
        if (args && typeof args === 'object') {
          detail = String(args.command ?? args.cmd ?? JSON.stringify(args)).replace(/\s+/g, ' ').slice(0, 200);
        }
      } catch { /* 参数不可序列化时留空 */ }
      const callId = exec?.callId ?? exec?.toolCallId ?? null;
      const at = Date.now();
      const entry = {
        at,
        name,
        ok,
        detail,
        note,
        verifying: /^(bash|run_code|lint_|browser_|test|tracescope_)/.test(name),
        callId,
        key: entryKey({ callId, name, detail, at }),
      };
      s.activity.push(entry);
      if (s.activity.length > activityLimit) s.activity.splice(0, s.activity.length - activityLimit);
      appendActivity(key, entry);
    } catch { /* 观察失败不影响调用 */ }
    return decision;
  });

  /* ── 接缝三：收尾门禁（本轮要结束而账本未收口 → 注入一条提醒） ── */

  ctx.on('agent/turn-stopping', async (payload) => {
    if (gateMode === 'off') return;
    try {
      const agent = payload?.agent;
      const session = agent?.session;
      if (!session) return;
      const key = sessionKeyOf(session?.id, session?.header?.cwd);
      const ledger = readLedger(key);
      if (!ledger) return;
      const live = liveItems(ledger);
      if (live.length === 0) return;
      const open = live.filter((it) => effectiveStatus(it) === 'open');
      const lc = ledger.lastCheck;
      const checkedAtCurrentRev = lc !== undefined && lc !== null && (lc.rev ?? -1) === (ledger.rev ?? 0);
      const settled = open.length === 0 && checkedAtCurrentRev && lc.verdict === 'complete';
      if (settled) return;
      const s = state(key);
      const turn = payload?.turn ?? s.turns;
      if (s.gateNotifiedTurn === turn) return; // 一轮最多提醒一次
      // 本轮啥也没干（没有观察到任何工具活动）就别唠叨：账本开着但只是闲聊。
      const persistedActivity = Array.isArray(ledger.activity) ? ledger.activity : [];
      if (persistedActivity.length === 0 && s.activity.length === 0) return;
      s.gateNotifiedTurn = turn;
      const missing = open.length;
      const why = checkedAtCurrentRev
        ? `上次核验是 ${lc.verdict}（缺 ${lc.missing} 条）`
        : '本轮还没有对账本做过核验';
      const text =
        `[完成门禁] 本轮即将结束，但任务契约账本还没收口：${why}；当前 ${live.length} 条契约里还有 ${missing} 条没有证据。\n` +
        '· 如果确实已经做完 → 先调 ledger_check 拿到 verdict，再对外宣称完成；\n' +
        '· 如果还差东西 → 直接说明还差哪几条，不要用「已完成」结束本轮。\n' +
        '（本条只提醒、不阻断；用 gateOnStop: off 可关闭。）';
      let injected = false;
      if (typeof agent.inject === 'function') {
        try {
          agent.inject(gateMessage(text));
          injected = true;
        } catch (err) {
          ctx.logger?.warn?.(`completion-ledger: 收尾门禁 inject 失败，降级到下一轮回注 ${String(err)}`);
        }
      }
      if (!injected) s.gateFallback = text; // 宿主无 agent.inject 时，下一次 pre-step 补上
      audit({ event: 'gate', session: key, turn, injected, open: missing, live: live.length, why });
      ctx.logger?.info?.(`completion-ledger: 收尾门禁触发（缺 ${missing} 条，injected=${injected}）`);
    } catch (err) {
      ctx.logger?.warn?.(`completion-ledger: 收尾门禁失败 ${String(err)}`);
    }
  });
}

export default { name, inject, Config, apply };
