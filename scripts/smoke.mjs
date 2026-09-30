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
import { existsSync, realpathSync, mkdtempSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

/* ── 结论 ──────────────────────────────────────────────────── */

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} · ${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
