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
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
expect(mod.sessionKeyOf(undefined, '/tmp/x') === mod.sessionKeyOf(undefined, '/tmp/x'), 'cwd 哈希稳定');

const empty = mod.checkLedger(mod.emptyLedger('s', '/tmp'), []);
expect(empty.verdict === 'empty' && empty.total === 0, `空账本 → verdict=${empty.verdict}`);

const one = mod.emptyLedger('s', '/tmp');
one.items.push({ id: 'R1', text: '要求一', kind: 'requirement', status: 'open', evidence: [] });
const inc = mod.checkLedger(one, [{ name: 'bash', ok: true, verifying: true }]);
expect(inc.verdict === 'incomplete' && inc.missing === 1 && inc.missingItems[0].id === 'R1',
  `无证据 → verdict=${inc.verdict}，缺口 ${inc.missingItems.map((i) => i.id).join(',')}`);

one.items[0].evidence.push({ at: Date.now(), kind: 'command', ref: 'bash scripts/smoke.mjs', note: 'exit 0' });
expect(mod.effectiveStatus(one.items[0]) === 'evidenced', 'effectiveStatus：有证据 → evidenced');
const comp = mod.checkLedger(one, [{ name: 'bash', ok: true, verifying: true }]);
expect(comp.verdict === 'complete' && comp.warnings.length === 0, `有证据 + 有验证动作 → verdict=${comp.verdict}`);
const comp2 = mod.checkLedger(one, [{ name: 'write', ok: true, verifying: false }]);
expect(comp2.verdict === 'complete' && comp2.warnings.length === 1, '只有写操作时给出「没有验证类动作」告警');

const noteText = mod.renderNote(one, { maxNoteChars: 1800 });
expect(noteText.includes('[任务契约账本]') && noteText.includes('R1'), 'renderNote 含标题与条目');
expect(mod.renderNote(one, { maxNoteChars: 80 }).includes('已截断'), 'renderNote 超限截断');

/* ── 结论 ──────────────────────────────────────────────────── */

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} · ${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
