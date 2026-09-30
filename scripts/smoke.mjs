#!/usr/bin/env node
/**
 * dsh-completion-ledger 自检（不起宿主、不需要 Electron）：
 *
 *   1) 入口可装载：导出 name / apply / 四个工具的构造依赖；
 *   2) 回注消息契约：`reinjectMessage()` 产出的 user 消息必须带生产者自己的
 *      `source.kind`（不是 catch-all 的 `'plugin'`）、`form: 'notice'` 且
 *      `summary` 不超过 120 字符；存在宿主校验器时再跑一遍 v4 行准入。
 *   3) 账本纯函数：checkLedger / renderNote / sessionKeyOf / effectiveStatus。
 *
 * 背景（回归用例的来源）：回注消息曾经既缺 `source` 又用 `kind: 'plugin:…'`，
 * 前者让会话投影层读 `source.kind` 直接崩（failed to project session …），
 * 后者被 v4 准入拒收。这两条现在由第 2 项钉住。
 *
 * 用法：node scripts/smoke.mjs        （退出码非 0 即失败）
 */
import { existsSync, realpathSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let passed = 0;
let failed = 0;
const ok = (msg) => { passed += 1; console.log(`  \u2713 ${msg}`); };
const bad = (msg) => { failed += 1; console.error(`  \u2717 ${msg}`); };
const expect = (cond, msg) => (cond ? ok(msg) : bad(msg));

/* ── 1) 入口装载 ───────────────────────────────────────────── */

console.log('=== 1) 入口装载 ===');
const mod = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href).catch((err) => {
  bad(`装载失败：${err?.code ?? err?.name} ${String(err?.message).split('\n')[0]}`);
  return null;
});
if (!mod) {
  console.error('\n自检失败：入口无法装载');
  process.exit(1);
}
expect(mod.name === 'completion-ledger', `name = ${mod.name}`);
expect(typeof mod.apply === 'function', 'apply 是函数');
expect(typeof mod.reinjectMessage === 'function', 'reinjectMessage 已导出');

/* ── 2) 回注消息契约 ───────────────────────────────────────── */

console.log('=== 2) 回注消息契约（source.kind / form / summary） ===');
const why = '账本有更新';
const note = 'x'.repeat(3000);
const msg = mod.reinjectMessage(why, note);
expect(msg?.role === 'user', `role = ${msg?.role}`);
expect(typeof msg?.id === 'string' && msg.id.length > 0, 'id 是稳定标识（随机 UUID）');
expect(Array.isArray(msg?.content) && msg.content.length > 0 && msg.content[0]?.type === 'text', 'content 是 text 块数组');
expect(String(msg?.content?.[0]?.text ?? '').includes(why) && String(msg?.content?.[0]?.text ?? '').includes(note), '正文含原因与已渲染账本');
expect(msg?.source !== undefined && msg.source !== null, 'source 存在（缺失会让投影层读 source.kind 崩溃）');
expect(msg?.source?.kind === 'completion-ledger', `source.kind = ${msg?.source?.kind}`);
expect(msg?.source?.kind !== 'plugin', 'source.kind 不是 catch-all 的 plugin');
expect(msg?.source?.form === 'notice', `source.form = ${msg?.source?.form}`);
expect(typeof msg?.source?.summary === 'string' && msg.source.summary.length > 0 && msg.source.summary.length <= 120,
  `summary 非空且 ≤120 字符（实际 ${msg?.source?.summary?.length ?? 'n/a'}）`);
expect(Object.isFrozen(msg), '消息被冻结（createUserMessage 的不可变约定）');

// 宿主校验器（存在则跑真准入；版本/位置不匹配时降级为上面的结构自检）
let fmtPath = null;
try {
  const llmEntry = realpathSync(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-llm')));
  // …/node_modules/@deepseek-ai/dsh-llm/lib/index.js → …/node_modules/@deepseek-ai
  const scopeDir = dirname(dirname(dirname(llmEntry)));
  const candidate = join(scopeDir, 'dsh-session-format-v3-to-v4', 'lib', 'index.js');
  if (existsSync(candidate)) fmtPath = candidate;
} catch { /* 校验器可选 */ }
if (fmtPath) {
  const fmt = await import(pathToFileURL(fmtPath).href);
  try {
    fmt.assertV4RowAdmission({ type: 'user/message', data: msg });
    ok('通过宿主 v4 会话格式行准入（assertV4RowAdmission）');
  } catch (err) {
    bad(`v4 行准入拒绝：${String(err?.message).split('\n')[0]}`);
  }
  // 反例：catch-all 的 plugin kind 必须被拒（证明这一项真的在验东西）
  try {
    const bogus = mod.reinjectMessage(why, note);
    Object.defineProperty(bogus, 'source', { value: { kind: 'plugin' }, enumerable: true });
    fmt.assertV4RowAdmission({ type: 'user/message', data: bogus });
    bad('反例未被拒收：kind=plugin 竟然通过准入');
  } catch {
    ok('反例被拒收：kind=plugin 触发 producer-owned source kind 校验');
  }
} else {
  console.log('  - 未找到 dsh-session-format-v3-to-v4，跳过宿主准入（已做结构自检）');
}

/* ── 3) 账本纯函数 ─────────────────────────────────────────── */

console.log('=== 3) 账本纯函数 ===');
expect(mod.sessionKeyOf('sess/1:2', '/tmp/x') === 'sess_1_2', 'sessionKeyOf 清洗非法字符');
expect(String(mod.sessionKeyOf(undefined, '/tmp/x')).startsWith('cwd-'), 'sessionKeyOf 无 id 时退化为 cwd 哈希');
const keyOnce = mod.sessionKeyOf(undefined, '/tmp/x');
const keyAgain = mod.sessionKeyOf(undefined, '/tmp/x');
expect(keyOnce === keyAgain, 'cwd 哈希在同一进程内稳定（纯函数、无隐藏状态）');
expect(keyOnce !== mod.sessionKeyOf(undefined, '/tmp/y'), 'cwd 哈希区分不同目录');

const empty = mod.checkLedger(mod.emptyLedger('s', '/tmp'), []);
expect(empty.verdict === 'empty' && empty.total === 0, `空账本 → verdict=${empty.verdict}`);

const one = mod.emptyLedger('s', '/tmp');
one.items.push({ id: 'R1', text: '要求一', kind: 'requirement', status: 'open', evidence: [] });
const inc = mod.checkLedger(one, [{ name: 'bash', ok: true, verifying: true }]);
expect(inc.verdict === 'incomplete' && inc.missing === 1 && inc.missingItems[0].id === 'R1',
  `无证据 → verdict=${inc.verdict}，缺口 ${inc.missingItems.map((i) => i.id).join(',')}`);

one.items[0].evidence.push({ at: Date.now(), kind: 'command', ref: 'bash scripts/smoke.mjs', note: 'exit 0' });
expect(mod.effectiveStatus(one.items[0]) === 'evidenced', 'effectiveStatus：有证据 → evidenced');
// 活动条目要带 detail（命令原文）——否则证据引用无从比对，会被判成自报证据。
const act = (name, detail, verifying) => ({ at: Date.now() - 1000, name, detail, verifying });
const comp = mod.checkLedger(one, [act('bash', 'bash scripts/smoke.mjs', true)]);
expect(comp.verdict === 'complete' && comp.warnings.length === 0, `有证据 + 有验证动作 → verdict=${comp.verdict}`);
const comp2 = mod.checkLedger(one, [act('write', 'lib/index.js', false)]);
expect(comp2.verdict === 'complete' && comp2.warnings.some((w) => w.includes('没有任何「验证类」动作')),
  '只有写操作时给出「没有验证类动作」告警（同时会点出未被支撑的证据）');

const noteText = mod.renderNote(one, { maxNoteChars: 1800 });
expect(noteText.includes('[任务契约账本]') && noteText.includes('R1'), 'renderNote 含标题与条目');
expect(mod.renderNote(one, { maxNoteChars: 80 }).includes('已截断'), 'renderNote 超限截断');

/* ── 4) 证据证伪（matchEvidence / strictEvidence） ─────────── */

console.log('=== 4) 证据证伪：自报证据不再与真证据等价 ===');
expect(mod.matchEvidence({ kind: 'manual', ref: '人工核对' }, []).verified === null, 'manual 证据不参与动作比对');
const mHit = mod.matchEvidence({ kind: 'command', ref: 'node scripts/smoke.mjs', at: Date.now() }, [act('bash', 'node scripts/smoke.mjs', true)]);
expect(mHit.verified === true, `引用与已观察动作匹配 → verified=${mHit.verified}`);
const mMiss = mod.matchEvidence({ kind: 'command', ref: 'pytest tests/test_api.py', at: Date.now() }, [act('bash', 'node scripts/smoke.mjs', true)]);
expect(mMiss.verified === false, '没有任何匹配动作 → verified=false（疑似自报）');
expect(mod.matchEvidence({ kind: 'command', ref: '', at: Date.now() }, []).verified === false, '空引用 → 无法核验');
const trimmed = mod.recordActivity([1, 2, 3], 4, 3);
expect(trimmed.length === 3 && trimmed[2] === 4, 'recordActivity 追加并裁剪到上限');

const fake = mod.emptyLedger('s2', '/tmp');
fake.items.push({ id: 'R1', text: '要求一', kind: 'requirement', status: 'open', evidence: [{ at: Date.now(), kind: 'command', ref: 'pytest tests/x.py' }] });
const softCheck = mod.checkLedger(fake, [act('bash', 'node scripts/smoke.mjs', true)]);
expect(softCheck.verdict === 'complete' && softCheck.unverified.length === 1, '默认：自报证据只告警、不算缺口');
const hardCheck = mod.checkLedger(fake, [act('bash', 'node scripts/smoke.mjs', true)], { strictEvidence: true });
expect(hardCheck.verdict === 'incomplete' && hardCheck.downgraded.includes('R1'),
  `strictEvidence=true → 拿不出证据的降级为缺口（verdict=${hardCheck.verdict}）`);

/* ── 5) 端到端（假 ctx，不起宿主） ─────────────────────────── */

console.log('=== 5) 端到端：契约 → 证据核验 → 收尾门禁 ===');

/** 只覆盖 apply() 真正用到的四个面：tools.register / on / logger / systemPrompt。 */
function makeFakeCtx() {
  const tools = new Map();
  const hooks = new Map();
  const logs = [];
  return {
    tools: { register: (t) => { tools.set(t.name, t); return t; } },
    on: (name, fn) => { const arr = hooks.get(name) ?? []; arr.push(fn); hooks.set(name, arr); },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    systemPrompt: { section: () => {} },
    _tools: tools,
    _hooks: hooks,
    _logs: logs,
  };
}

const tmpDir = mkdtempSync(join(tmpdir(), 'dsh-ledger-'));
const ctx = makeFakeCtx();
mod.apply(ctx, { storageDir: tmpDir, persistedActivityLimit: 10, gateOnStop: 'remind' });
const T = ctx._tools;
const session = { id: 'e2e-1', header: { cwd: '/tmp/e2e' }, snapshotEvents: () => [] };
const injected = [];
const agent = { session, cwd: '/tmp/e2e', inject: (m) => injected.push(m) };
const exec = { agent };
const post = ctx._hooks.get('tools/post-execute')[0];
const pre = ctx._hooks.get('agent/pre-step')[0];
const stop = ctx._hooks.get('agent/turn-stopping')[0];

expect(T.size === 4, `注册 4 个工具（实际 ${T.size}）`);
const opened = await T.get('ledger_open').execute({ requirements: ['要求一'], constraints: ['不改范围外文件'] }, exec);
expect(opened.includes('已登记 2 条'), 'ledger_open 登记 2 条契约');

// 一次真实动作（bash 跑 smoke），活动应落盘
await post({ name: 'bash', args: { command: 'node scripts/smoke.mjs' }, agent }, {}, async () => ({ kind: 'accept', content: [{ type: 'text', text: 'PASS · 24 通过 / 0 失败' }] }));
const ev1 = await T.get('ledger_evidence').execute({ item: 'R1', kind: 'command', ref: 'node scripts/smoke.mjs', note: 'exit 0' }, exec);
expect(ev1.includes('已被观察到的动作支撑'), '真证据被判定为「有动作支撑」');
const ev2 = await T.get('ledger_evidence').execute({ item: 'C2', kind: 'command', ref: 'pytest tests/test_api.py', note: '全绿' }, exec);
expect(ev2.includes('未观察到支撑动作'), '自报证据被当场点出');

// 默认模式：complete，但把自报证据列出来
const chk = await T.get('ledger_check').execute({ claim: '做完了' }, exec);
expect(chk.includes('verdict: complete') && chk.includes('未被动作支撑的证据'), '默认模式：complete + 自报证据告警');
injected.length = 0;
await stop({ agent, turn: 1 });
expect(injected.length === 0, '账本已收口（complete 且 rev 一致）→ 收尾门禁不打扰');

// 严格模式（另一个 ctx 实例、同一账本目录）：自报证据降级为缺口
const ctx2 = makeFakeCtx();
mod.apply(ctx2, { storageDir: tmpDir, strictEvidence: true });
const strict = await ctx2._tools.get('ledger_check').execute({ claim: '做完了' }, exec);
expect(strict.includes('verdict: incomplete'), 'strictEvidence=true → 核验结论变成 incomplete');

// 未收口 → 收尾门禁注入一次；同一轮不重复
await stop({ agent, turn: 7 });
expect(injected.length === 1 && injected[0]?.source?.kind === 'completion-ledger', '账本未收口 → 门禁注入一条提醒（生产者自有 source.kind）');
await stop({ agent, turn: 7 });
expect(injected.length === 1, '同一轮不重复提醒');

// 降级路径：宿主不提供 agent.inject 时，由下一次 pre-step 补投
const agentNoInject = { session, cwd: '/tmp/e2e' };
await stop({ agent: agentNoInject, turn: 8 });
const decision = await pre({ agent: agentNoInject }, async () => ({ kind: 'enter', messages: [] }));
expect(Array.isArray(decision?.messages) && decision.messages.some((m) => m?.source?.kind === 'completion-ledger'),
  '无 agent.inject 时，门禁提醒由下一次 pre-step 补投');

// 审计与活动落盘
expect(existsSync(join(tmpDir, 'audit.jsonl')), '审计 JSONL 已落盘（可回看核验/门禁是否真在干活）');
const persisted = JSON.parse(
  (await import('node:fs')).readFileSync(join(tmpDir, 'e2e-1.json'), 'utf8'),
);
expect(Array.isArray(persisted.activity) && persisted.activity.length >= 1 && persisted.activity[0].detail.includes('scripts/smoke.mjs'),
  '工具活动已落盘且带命令原文（跨重启仍可核验证据）');

/* ── 6) 会话日志重放（dsh-doublecheck 的设计：事实只认持久日志） ── */

console.log('=== 6) 会话日志重放与兼容层 ===');
const compat = await import(pathToFileURL(join(ROOT, 'lib', 'compat', 'index.js')).href);
const replay = await import(pathToFileURL(join(ROOT, 'lib', 'replay.js')).href);

const rowsV4 = [
  { type: 'tool/call', seq: 1, time: Date.now() - 5000, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'pnpm vitest run', description: 'x' }) } },
  { type: 'tool/result', seq: 2, time: Date.now() - 4900, data: { turn: 1, step: 1, message: { role: 'tool', source: { kind: 'tool', callId: 'c1' }, toolCallId: 'c1', content: [{ type: 'text', text: '141 passed\n[exit code: 0]' }] } } },
  { type: 'tool/call', seq: 3, time: Date.now() - 4000, data: { turn: 1, step: 2, callId: 'c2', name: 'write', arguments: JSON.stringify({ path: 'lib/index.js' }) } },
  { type: 'tool/result', seq: 4, time: Date.now() - 3900, data: { turn: 1, step: 2, message: { role: 'tool', source: { kind: 'tool', callId: 'c2' }, toolCallId: 'c2', content: [{ type: 'text', text: 'ok' }] } } },
];
const replayed = replay.replayActivity(rowsV4, { limit: 10 });
expect(replayed.length === 2, `重放出 2 条活动（实际 ${replayed.length}）`);
expect(replayed[0].detail === 'pnpm vitest run' && replayed[0].ok === true && replayed[0].exitCode === 0 && replayed[0].verifying === true,
  'bash 活动带命令原文、退出码与「验证类」标记');
expect(replayed[1].detail === 'lib/index.js' && replayed[1].verifying === false, 'write 活动取 path 作为 detail、非验证类');
expect(replay.replayActivity(rowsV4, { sinceSeq: 2 }).length === 1, 'sinceSeq 支持增量重放');

const rowsV3 = [
  { type: 'tool/call', seq: 1, time: Date.now() - 1000, data: { callId: 'c9', name: 'bash', arguments: '{"command":"go test ./..."}' } },
  { type: 'user/message', seq: 2, time: Date.now() - 900, data: { message: { role: 'user', source: { kind: 'tool', callId: 'c9' }, toolCallId: 'c9', content: [{ type: 'text', text: 'FAIL\n[exit code: 1]' }] } } },
];
const v3 = replay.replayActivity(rowsV3, { limit: 5 });
expect(v3.length === 1 && v3[0].ok === false && v3[0].exitCode === 1, '旧形态（user/message 里的工具结果）被认出，失败退出码正确');
expect(replay.mergeActivity(replayed, replayed).length === 2, 'mergeActivity 按 callId 去重');

const mkSession = (shape) => ({
  ...(shape === 'snapshot' ? { snapshotEvents: () => rowsV4 } : {}),
  ...(shape === 'events' ? { events: rowsV4 } : {}),
  ...(shape === 'own' ? { ownEvents: () => rowsV4 } : {}),
});
expect(compat.eventsOf(mkSession('snapshot')).length === 4 && compat.eventsOf(mkSession('events')).length === 4 && compat.eventsOf(mkSession('own')).length === 4,
  'eventsOf 认 snapshotEvents() / events / ownEvents() 三种形态');
expect(compat.eventsOf({}).length === 0, '都拿不到时返回空数组（由调用方按「无事实」处理，不解释成「没有活动」）');
expect(compat.typeOf({ data: { type: 'x' } }) === 'x' && compat.seqOf({ seq: 7 }) === 7, 'typeOf/seqOf 兼容缺字段的旧行');
const sv = await compat.sessionFormatVersion();
expect(sv === null || Number.isFinite(sv), `会话格式版本 = ${sv}（宿主导出常量；缺失则退化为形态识别，不影响装载）`);

/* ── 7) 只读 Git 取证与交付报告 ─────────────────────────────── */

console.log('=== 7) 只读取证（零宿主 API）与交付报告 ===');
const gitmod = await import(pathToFileURL(join(ROOT, 'lib', 'git-evidence.js')).href);
expect(gitmod.parseFileRef('lib/index.js:42').path === 'lib/index.js' && gitmod.parseFileRef('lib/index.js:42').line === 42, 'parseFileRef 拆出路径与行号');
expect(gitmod.parseFileRef('a/b.md').line === null, 'parseFileRef 无行号时 line=null');
const genv = gitmod.gitEnv({ PATH: '/usr/bin', GIT_DIR: '/tmp/evil', GIT_WORK_TREE: '/tmp/evil2', HOME: '/x' });
expect(genv.PATH === '/usr/bin' && genv.HOME === '/x' && genv.GIT_DIR === undefined && genv.GIT_WORK_TREE === undefined && genv.GIT_TERMINAL_PROMPT === '0',
  'gitEnv 清空 GIT_* 并禁止交互提问（只读查询不会被重定向到别的仓库）');

const selfFacts = await gitmod.fileEvidenceFacts({ cwd: ROOT, ref: 'lib/index.js:1' });
expect(selfFacts.ok === true && selfFacts.exists === true && selfFacts.tracked === true, '本仓库文件：存在且被 git 跟踪（客观事实，非模型自述）');
const ghost = await gitmod.fileEvidenceFacts({ cwd: ROOT, ref: 'lib/does-not-exist.js:1' });
expect(ghost.ok === false && ghost.exists === false, '不存在的文件直接判否（引用不存在的东西不能算证据）');
const outside = await gitmod.collectGitEvidence({ cwd: tmpdir() });
expect(outside.ok === false && typeof outside.reason === 'string' && outside.reason !== '', '非仓库目录：如实返回失败原因，而不是「零文件」');

const report = mod.renderReport(one, mod.checkLedger(one, [act('bash', 'bash scripts/smoke.mjs', true)]), { key: 'k', cwd: '/tmp', replayed: 1, persisted: 0, memory: 0 });
expect(report.includes('交付报告') && report.includes('R1') && report.includes('核验结论'), 'renderReport 含结论、条目与图例');

/* ── 8) 端到端：事实完全来自会话日志重放 ───────────────────── */

console.log('=== 8) 端到端：不打一次 post-execute 也能核验证据 ===');
const tmpDir2 = mkdtempSync(join(tmpdir(), 'dsh-ledger-replay-'));
const ctx3 = makeFakeCtx();
mod.apply(ctx3, { storageDir: tmpDir2, persistedActivityLimit: 10 });
const T3 = ctx3._tools;
const replayRows = [
  { type: 'tool/call', seq: 1, time: Date.now() - 3000, data: { callId: 'r1', name: 'bash', arguments: JSON.stringify({ command: 'node scripts/smoke.mjs' }) } },
  { type: 'tool/result', seq: 2, time: Date.now() - 2900, data: { message: { role: 'tool', source: { kind: 'tool', callId: 'r1' }, toolCallId: 'r1', content: [{ type: 'text', text: 'PASS · 45 通过 / 0 失败\n[exit code: 0]' }] } } },
];
const replayedSession = { id: 'replay-1', header: { cwd: ROOT }, snapshotEvents: () => replayRows };
const replayedAgent = { session: replayedSession, cwd: ROOT, inject: () => {} };
await T3.get('ledger_open').execute({ requirements: ['跑通冒烟'] }, { agent: replayedAgent });
const replayedEv = await T3.get('ledger_evidence').execute({ item: 'R1', kind: 'command', ref: 'node scripts/smoke.mjs', note: 'exit 0' }, { agent: replayedAgent });
expect(replayedEv.includes('已被观察到的动作支撑'), '只靠会话日志重放，证据也被判定为「有动作支撑」（插件晚装/重启后同样成立）');
const replayedCheck = await T3.get('ledger_check').execute({ claim: '跑通了' }, { agent: replayedAgent });
expect(replayedCheck.includes('verdict: complete') && replayedCheck.includes('会话日志重放 1 条'), '核验结论标出事实来自重放');

/* ── 9) 回归：一次外部评审挖出的 7 类缺陷（每条都由断言钉住） ─── */

console.log('=== 9) 评审回归：先前「全绿但不可用」的那几处 ===');

// R1 ledger_status 曾在有账本时必抛 ReferenceError（recent is not defined）
const statusOut = await T.get('ledger_status').execute({}, exec);
expect(typeof statusOut === 'string' && statusOut.includes('事实来源'), 'ledger_status 有账本时正常返回（曾抛 ReferenceError）');
expect(statusOut.includes('事件源') || statusOut.includes('事件源不可用'), 'ledger_status 披露事件源与可用性');

// R2 ok 三态：非 bash 的失败必须被判 false，而不是「没标记就算成功」；没有结果行则 null
const replayedFail = replay.replayActivity([
  { type: 'tool/call', seq: 1, time: Date.now() - 2000, data: { callId: 'f1', name: 'edit', arguments: '{"path":"a.js"}' } },
  { type: 'tool/result', seq: 2, time: Date.now() - 1900, data: { message: { toolCallId: 'f1', content: [{ type: 'text', text: 'Error: [sandbox: file access denied under workspace-write mode]' }] } } },
  { type: 'tool/call', seq: 3, time: Date.now() - 1000, data: { callId: 'f2', name: 'bash', arguments: '{"command":"true"}' } },
], { limit: 10 });
expect(replayedFail[0].ok === false && replayedFail[0].okSource === 'error-text', `非 bash 失败判 false（实际 ok=${replayedFail[0].ok} source=${replayedFail[0].okSource}）`);
expect(replayedFail[1].ok === null && replayedFail[1].okSource === 'no-result', '没有结果行 → ok=null（无从判定），不再默认 true');
expect(replay.exitCodeOf('正文提到 [exit code: 0] 这串字\n[exit code: 1]') === 1, '退出码取最后一个标记（避免被正文里的字面量吞掉）');
expect(replay.looksLikeFailure('Error: the user rejected tool "bash"') === true, '识别「用户拒绝工具」这类失败文本');

// R3 事实不可得 ≠ 没做过：事件源抛错时不得判「疑似自报」，严格模式下也不得降级
const deadSession = { id: 'dead', header: { cwd: ROOT }, snapshotEvents: () => { throw new Error('boom'); } };
const deadJudge = mod.matchEvidence({ kind: 'command', ref: 'pytest tests/x.py', at: Date.now() }, [], { factsAvailable: false, factsReason: '事件源抛错' });
expect(deadJudge.verified === null && deadJudge.reason.includes('事实不可得'), '事实不可得 → verified=null（不能据此认定自报）');
expect(compat.eventsInfo(deadSession).available === false && compat.eventsInfo({ snapshotEvents: () => [] }).available === true,
  'eventsInfo 区分「事件源抛错」与「真的是空日志」');

// R4 中文引用是「无法比对」，不是「没做过」
expect(mod.matchEvidence({ kind: 'command', ref: '人工核对了会话日志重放结果', at: Date.now() }).verified === null, '纯中文引用 → null');
expect(mod.matchEvidence({ kind: 'command', ref: '', at: Date.now() }).verified === false, '空引用仍然判 false');

// R5 工具**输出文本**里出现同名字符串，不算做了这件事
const haystackTrap = mod.matchEvidence(
  { kind: 'command', ref: 'pytest tests/test_api.py', at: Date.now() },
  [{ at: Date.now() - 500, name: 'bash', detail: 'cat README.md', note: 'README 里提到 pytest tests/test_api.py' }],
);
expect(haystackTrap.verified === false, '指纹池只用「工具名+参数」，输出文本不再能伪证');

// R6 文件类证据：客观取证为正即成立（不再被动作比对否掉）；无 cwd / 行号越界各有明确结论
const tmpRepo = mkdtempSync(join(tmpdir(), 'dsh-ledger-git-'));
execFileSync('git', ['init', '-q'], { cwd: tmpRepo });
writeFileSync(join(tmpRepo, 'a.txt'), 'one\ntwo\n');
execFileSync('git', ['add', 'a.txt'], { cwd: tmpRepo });
const okFile = await gitmod.fileEvidenceFacts({ cwd: tmpRepo, ref: 'a.txt:2' });
expect(okFile.ok === true && okFile.exists === true && okFile.tracked === true && okFile.lineInRange === true, '真实文件：存在/被跟踪/行号在范围内');
const badLine = await gitmod.fileEvidenceFacts({ cwd: tmpRepo, ref: 'a.txt:999' });
expect(badLine.ok === true && badLine.lineInRange === false && badLine.totalLines === 2, '行号越界被点出（totalLines=2）');
expect((await gitmod.fileEvidenceFacts({ ref: 'a.txt:1' })).ok === false, '没有会话 cwd → 拒绝取证（不再落到插件进程的 cwd）');
expect(gitmod.parseFileRef('b.txt:007').line === 7 && gitmod.parseFileRef('b.txt:007').path === 'b.txt', ':007 按前导零解析（曾误判成文件不存在）');

const tmpDir3 = mkdtempSync(join(tmpdir(), 'dsh-ledger-file-'));
const ctx4 = makeFakeCtx();
mod.apply(ctx4, { storageDir: tmpDir3 });
const fileAgent = { session: { id: 'file-1', header: { cwd: tmpRepo }, snapshotEvents: () => [] }, cwd: tmpRepo, inject: () => {} };
await ctx4._tools.get('ledger_open').execute({ requirements: ['改了 a.txt'] }, { agent: fileAgent });
const fileEv = await ctx4._tools.get('ledger_evidence').execute({ item: 'R1', kind: 'file', ref: 'a.txt:2' }, { agent: fileAgent });
expect(fileEv.includes('只读 git 取证') && !fileEv.includes('未观察到支撑动作'), '文件类证据由 git 取证判定成立（曾因没有匹配动作被判「疑似自报」）');

// R7 同一动作不得被重放与落盘各算一次
const mergedOnce = replay.mergeActivity(
  [{ callId: 'same', name: 'bash', detail: 'pnpm test', at: 1000, key: 'c:same' }],
  [{ name: 'bash', detail: 'pnpm test', at: 1001, key: 'c:same' }],
);
expect(mergedOnce.length === 1, `同 callId 的重放+落盘只算一条（实际 ${mergedOnce.length}）`);

// R8 git 环境白名单：继承来的 GIT_* 一个都不能漏进去
const inherited = gitmod.gitEnv({ PATH: '/usr/bin', GIT_LITERAL_PATHSPECS: '1', GIT_CONFIG_GLOBAL: '/tmp/evil', GIT_DIR: '/tmp/x', HOME: '/h' });
expect(inherited.GIT_LITERAL_PATHSPECS === undefined && inherited.GIT_CONFIG_GLOBAL === '/dev/null' && inherited.GIT_DIR === undefined && inherited.PATH === '/usr/bin',
  'gitEnv 白名单：只留必要变量，并显式切断用户/系统 git 配置');

// R9 含重命名的 status -z 不再产出幻影条目
writeFileSync(join(tmpRepo, 'b.txt'), 'x\n');
execFileSync('git', ['add', 'b.txt'], { cwd: tmpRepo });
execFileSync('git', ['commit', '-qm', 'init'], { cwd: tmpRepo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
execFileSync('git', ['mv', 'a.txt', 'renamed.txt'], { cwd: tmpRepo });
const gitEvidence = await gitmod.collectGitEvidence({ cwd: tmpRepo });
const renamed = gitEvidence.changed.sample.join(' | ');
expect(!/a\. s/.test(renamed), `重命名不再产出幻影条目「a. s」（实际：${renamed}）`);
expect(/renamed\.txt/.test(renamed), '重命名本身被记录（而不是整条丢失）');

// R10 时间不合法不再打坏比对（NaN 会让条目掉出时间窗、并让去重键互相塌缩）
expect(replay.finiteTime('2026-09-30T00:00:00Z', 42) === 42 && replay.finiteTime(undefined, 42) === 42 && replay.finiteTime(1234, 0) === 1234,
  '非法/缺失时间退化为 seq（不再是 NaN 或 Date.now()）');

// R11 同一 callId 的多条结果（compaction/prune 重发副本）不得把失败翻成成功
const dupResults = replay.replayActivity([
  { type: 'tool/call', seq: 1, time: Date.now() - 3000, data: { callId: 'd1', name: 'bash', arguments: '{"command":"pnpm test"}' } },
  { type: 'tool/result', seq: 2, time: Date.now() - 2900, data: { message: { toolCallId: 'd1', content: [{ type: 'text', text: '2 failed\n[exit code: 1]' }] } } },
  { type: 'tool/result', seq: 9, time: Date.now() - 100, data: { message: { toolCallId: 'd1', content: [{ type: 'text', text: '[... tool result middle pruned ...]' }] } } },
], { limit: 5 });
expect(dupResults.length === 1 && dupResults[0].ok === false, `多副本取保守结论（失败不被裁剪副本翻成成功，ok=${dupResults[0].ok}）`);

// R12 callId 缺失不再丢事实（用 seq 兜底），且该事实仍能支撑证据
const noCallId = replay.replayActivity([
  { type: 'tool/call', seq: 7, time: Date.now() - 1000, data: { name: 'bash', arguments: '{"command":"node scripts/smoke.mjs"}' } },
], { limit: 5 });
expect(noCallId.length === 1 && noCallId[0].callIdMissing === true && noCallId[0].ok === null,
  'callId 缺失：事实保留（标注 callIdMissing），成败为 null 而不是默认成功');
expect(mod.matchEvidence({ kind: 'command', ref: 'node scripts/smoke.mjs', at: Date.now() }, noCallId).verified === true,
  'callId 缺失的事实仍能支撑证据（不再因缺 id 被丢弃）');

// R13 长会话里**早期**挂的证据不得因「最近 N 条」窗口被误判成自报
const longRows = [{ type: 'tool/call', seq: 1, time: Date.now() - 3600_000, data: { callId: 'early', name: 'bash', arguments: '{"command":"node scripts/smoke.mjs"}' } },
  { type: 'tool/result', seq: 2, time: Date.now() - 3600_000 + 50, data: { message: { toolCallId: 'early', content: [{ type: 'text', text: 'PASS' }] } } }];
for (let i = 0; i < 80; i += 1) {
  longRows.push({ type: 'tool/call', seq: 10 + i * 2, time: Date.now() - 3000 + i, data: { callId: `late${i}`, name: 'bash', arguments: `{"command":"echo ${i}"}` } });
}
const tmpDir4 = mkdtempSync(join(tmpdir(), 'dsh-ledger-window-'));
const ctx5 = makeFakeCtx();
mod.apply(ctx5, { storageDir: tmpDir4, persistedActivityLimit: 10 });
const longAgent = { session: { id: 'window-1', header: { cwd: ROOT }, snapshotEvents: () => longRows }, cwd: ROOT, inject: () => {} };
await ctx5._tools.get('ledger_open').execute({ requirements: ['很早就跑过冒烟'] }, { agent: longAgent });
const earlyEv = await ctx5._tools.get('ledger_evidence').execute({ item: 'R1', kind: 'command', ref: 'node scripts/smoke.mjs', note: '1 小时前跑的' }, { agent: longAgent });
expect(earlyEv.includes('已被观察到的动作支撑'), '长会话里早期挂的证据仍被支撑（按证据时间回看，不再被「最近 N 条」窗口误伤）');

/* ── 结论 ──────────────────────────────────────────────────── */

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} · ${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
