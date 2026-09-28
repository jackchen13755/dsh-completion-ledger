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
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import z from '@deepseek-ai/schemastery';
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';

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
});

/* ────────────────────────── 纯函数（可单测） ────────────────────────── */

/** 会话键：优先 sessionId，退化到 cwd 的哈希。 */
export function sessionKeyOf(sessionId, cwd) {
  if (typeof sessionId === 'string' && sessionId !== '') return sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
  const basis = typeof cwd === 'string' && cwd !== '' ? cwd : 'unknown';
  return 'cwd-' + createHash('sha1').update(basis).digest('hex').slice(0, 12);
}

export function ledgerPath(dir, key) {
  return join(dir, key + '.json');
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

/** 完成核验：返回 verdict 与逐条缺口。 */
export function checkLedger(ledger, activity = []) {
  const items = Array.isArray(ledger?.items) ? ledger.items : [];
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
  if (missing.length === 0 && items.length > 0 && verifying.length === 0) {
    warnings.push('所有条目都有证据，但本轮没有任何「验证类」动作（命令/测试/核验）被观察到——证据是否为纯手工声明？');
  }
  if (items.length === 0) warnings.push('账本为空：先用 ledger_open 记录要求，否则核验没有依据。');
  return {
    verdict: items.length === 0 ? 'empty' : missing.length === 0 ? 'complete' : 'incomplete',
    total: items.length, done: done.length, missing: missing.length,
    missingItems: missing.map((it) => ({ id: it.id, text: it.text, evidence: it.evidence?.length ?? 0 })),
    doneItems: done.map((it) => ({ id: it.id, text: it.text, evidence: it.evidence?.length ?? 0, status: effectiveStatus(it) })),
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
      const tag = ev ? `${ev.kind}${ev.ref ? ':' + String(ev.ref).slice(0, 80) : ''}` : '（无）';
      lines.push(`    ${it.id} ${String(it.text).replace(/\s+/g, ' ').slice(0, 120)} — ${tag}`);
    }
  }
  if (items.length === 0) lines.push('· 账本为空：先用 ledger_open 把要求记下来。');
  lines.push('（ledger_status 看全量；ledger_check 出核验结论；ledger_evidence 挂证据）');
  const text = lines.join('\n');
  return text.length > limit ? text.slice(0, limit) + '\n…（已截断）' : text;
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

/* ────────────────────────── 插件主体 ────────────────────────── */

export function apply(ctx, config) {
  if (!(config.enabled ?? true)) return;

  const dir = (config.storageDir && String(config.storageDir)) || defaultStorageDir();
  const maxNoteChars = config.maxNoteChars ?? 1800;
  const activityLimit = Math.max(1, config.activityLimit ?? 20);
  const sessions = new Map();

  const state = (key) => {
    let s = sessions.get(key);
    if (!s) {
      s = { key, compactions: 0, rev: -1, injected: 0, turns: 0, activity: [], briefed: false };
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

  const writeLedger = (key, ledger) => {
    try {
      mkdirSync(dir, { recursive: true });
      ledger.rev = (ledger.rev ?? 0) + 1;
      ledger.updatedAt = Date.now();
      writeFileSync(ledgerPath(dir, key), JSON.stringify(ledger, null, 1), 'utf8');
      const s = state(key);
      s.rev = ledger.rev;
      return true;
    } catch (err) {
      ctx.logger?.warn?.(`completion-ledger: 写入账本失败 ${String(err)}`);
      return false;
    }
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
      const head = added.length > 0 ? `已登记 ${added.length} 条：\n` + added.map((i) => `  ${i.id} ${i.text}`).join('\n') : '未新增条目（args 为空）。';
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
      target.evidence.push({ at: Date.now(), kind: String(args.kind ?? 'manual'), ref: args.ref ? String(args.ref).slice(0, 500) : '', note: args.note ? String(args.note).slice(0, 500) : '' });
      if (args.status === 'done' || args.status === 'dropped') target.status = args.status;
      writeLedger(key, ledger);
      const st = effectiveStatus(target);
      const open = ledger.items.filter((i) => effectiveStatus(i) === 'open').length;
      return `✅ ${target.id} 已挂证据（${args.kind}），状态=${st}。剩余无证据条目：${open} 条。`;
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
        for (const ev of it.evidence.slice(-3)) out.push(`    - ${ev.kind}${ev.ref ? ': ' + ev.ref : ''}${ev.note ? ' — ' + ev.note : ''}`);
      }
      if (s.activity.length > 0) {
        out.push('最近工具活动（内存，供核验参考）：');
        for (const a of s.activity.slice(-8)) out.push(`    ${a.ok ? '✓' : '✗'} ${a.name}${a.note ? ' — ' + a.note : ''}`);
      }
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
      const verdict = checkLedger(ledger, s.activity);
      const lines = [];
      lines.push(`verdict: ${verdict.verdict} · 共 ${verdict.total} 条 · 有证据 ${verdict.done} 条 · 缺证据 ${verdict.missing} 条`);
      if (args.claim) lines.push(`拟宣称：${String(args.claim).slice(0, 300)}`);
      if (verdict.missing > 0) {
        lines.push('未满足（不得声称完成，需逐条补证据或明确说明未做）：');
        for (const m of verdict.missingItems) lines.push(`  ${m.id} ${m.text}`);
      }
      if (verdict.doneItems.length > 0) {
        lines.push('已满足：');
        for (const d of verdict.doneItems) lines.push(`  ${d.id} ${d.text}（${d.evidence} 条证据，${d.status}）`);
      }
      for (const w of verdict.warnings) lines.push(`⚠️ ${w}`);
      if (verdict.verdict === 'complete') lines.push('可以宣称完成——但结论里要带上每条的证据出处。');
      return lines.join('\n');
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
      if (!decision || decision.kind !== 'enter') return decision;
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

  ctx.on('tools/post-execute', async (exec, result, next) => {
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
      s.activity.push({ at: Date.now(), name, ok, note, verifying: /^(bash|run_code|lint_|browser_|test|tracescope_)/.test(name) });
      if (s.activity.length > activityLimit) s.activity.splice(0, s.activity.length - activityLimit);
    } catch { /* 观察失败不影响调用 */ }
    return decision;
  });
}

export default { name, inject, Config, apply };
