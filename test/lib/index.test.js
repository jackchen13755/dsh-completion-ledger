/**
 * M1 证据收据 / M3 主矛盾钉住 / M6 终态收口的回归用例。
 *
 * 落点按仓根 `test/` + 镜像被测路径：被测 `lib/index.js` → `test/lib/index.test.js`。
 *
 * 手法与 scripts/smoke.mjs 一致：**不起宿主**，用假 ctx 拿真实工具对象、按真实
 * `execute(args, exec)` 调用；账本落盘到每个用例自己的临时目录，命令在临时 cwd 下真跑。
 * 这样每一条断言都在验「工具真的会怎么答」，而不是验某个纯函数被另写一遍。
 *
 * 跑法：npm test（= node --test test/）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import * as mod from '../../lib/index.js';

/** 只覆盖 apply() 真正用到的四个面（tools.register / on / logger / systemPrompt）。 */
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

let seq = 0;
/**
 * 建一个独立的「宿主 + 账本目录 + 会话 cwd」。
 *
 * 每个用例独立目录是刻意的：这些机制都会写盘（账本 / receipts.jsonl / audit.jsonl），
 * 共用目录会让用例之间互相污染，失败时也看不出是谁写的。
 */
function host(config = {}) {
  seq += 1;
  const dir = mkdtempSync(join(tmpdir(), `dsh-ledger-m16-${seq}-`));
  const cwd = mkdtempSync(join(tmpdir(), `dsh-ledger-cwd-${seq}-`));
  const ctx = makeFakeCtx();
  // receipt 默认关（安全前提）：绝大多数用例要验它的行为，所以这里显式打开；
  // 「默认关」这条用例自己传 `receipt: { enabled: false }` 覆盖回来。
  mod.apply(ctx, { storageDir: dir, gateOnStop: 'off', receipt: { enabled: true }, ...config });
  const session = { id: `m16-${seq}`, header: { cwd }, snapshotEvents: () => [] };
  const exec = { agent: { session, cwd } };
  const tool = (name) => ctx._tools.get(name);
  const call = (name, args) => tool(name).execute(args, exec);
  const ledgerKey = mod.sessionKeyOf(session.id);
  const ledgerFile = join(dir, `${ledgerKey}.json`);
  const read = () => JSON.parse(readFileSync(ledgerFile, 'utf8'));
  return { dir, cwd, ctx, exec, call, tool, read, ledgerKey, ledgerFile };
}

// 不传 `constraints: undefined`：宿主参数校验要求「无损 JSON 对象」，显式 undefined 会被拒。
const open = (h, requirements, constraints) => h.call('ledger_open', constraints === undefined ? { requirements } : { requirements, constraints });
/** 挂一条「已完成」的自述证据：用它把条目标成 done，从而单独验证矛盾/收口的判定。 */
const finishManual = (h, item) => h.call('ledger_evidence', { item, kind: 'manual', ref: '人工核对', status: 'done' });

/* ────────────────────────── M1 证据收据 ────────────────────────── */

test('M1 receipt：exit 0 → verified=true（boolean），回执字段齐全并落盘', async () => {
  const h = host();
  await open(h, ['要求一']);
  const text = await h.call('ledger_receipt', { item: 'R1', cmd: 'node -e "process.exit(0)"' });
  assert.match(text, /证据收据成立/);
  assert.match(text, /verified=true/);
  const led = h.read();
  const ev = led.items[0].evidence.at(-1);
  assert.equal(ev.kind, 'receipt');
  assert.equal(ev.verified, true);
  // 「verified 必须是 boolean」：null 在这一层等于「没证明」，不许冒充绿。
  assert.equal(typeof ev.verified, 'boolean');
  for (const k of ['cmd', 'exitCode', 'durationMs', 'at', 'outputTail', 'mode']) {
    assert.ok(Object.hasOwn(ev.receipt, k), `回执缺字段 ${k}`);
  }
  assert.equal(ev.receipt.exitCode, 0);
  assert.equal(ev.receipt.mode, 'run');
  assert.ok(existsSync(join(h.dir, 'receipts.jsonl')), '完整回执应另落 receipts.jsonl');
});

test('M1 receipt：exit 非 0 → verified=false，且不判绿（核验仍是 incomplete）', async () => {
  const h = host();
  await open(h, ['要求一']);
  const text = await h.call('ledger_receipt', { item: 'R1', cmd: 'node -e "process.exit(7)"' });
  assert.match(text, /证据收据未成立/);
  assert.match(text, /verified=false/);
  const ev = h.read().items[0].evidence.at(-1);
  assert.equal(ev.verified, false);
  assert.equal(ev.receipt.exitCode, 7);
  // 「有证据」不等于「跑通了」：失败的客观证据必须把条目从已满足里拖出来。
  const chk = await h.call('ledger_check', { claim: '做完了' });
  assert.match(chk, /verdict: incomplete/);
  // 失败的收据走「客观未通过」这条措辞（不是「疑似自报」），并真的把条目从已满足里拖出来。
  assert.match(chk, /证据收据\*\*未通过\*\*/);
  assert.match(chk, /未满足（不得声称完成/);
  assert.match(chk, /R1 要求一/);
  // 反向：刚跑过收据并失败时，不该再冒「本轮没有任何验证类动作——证据是否为纯手工声明」
  // （那正是验证类动作，而且它给了答案）。注：`unsupportedItems` 里仍会列出该条目
  // （仓库既有决定，smoke R3-1 钉住「只有失败的验收 → 仍算被打回」），这里不去动它。
  assert.doesNotMatch(chk, /纯手工声明/);
});

test('M1 receipt pair：基线绿（0）+ 变异红（3）→ 成立', async () => {
  const h = host();
  await open(h, ['要求一']);
  const text = await h.call('ledger_receipt', {
    item: 'R1',
    mode: 'pair',
    cmd: 'node -e "process.exit(0)"',
    mutant: 'node -e "process.exit(3)"',
  });
  assert.match(text, /证据收据成立/);
  assert.match(text, /基线绿、变异红/);
  const ev = h.read().items[0].evidence.at(-1);
  assert.equal(ev.verified, true);
  assert.equal(ev.receipt.mode, 'pair');
  assert.equal(ev.receipt.pair.baseline.exitCode, 0);
  assert.equal(ev.receipt.pair.mutant.exitCode, 3);
});

test('M1 receipt pair：基线绿 + 变异绿 → 拒绝，理由是「变异后仍然绿，这条闸门不会红」', async () => {
  const h = host();
  await open(h, ['要求一']);
  const text = await h.call('ledger_receipt', {
    item: 'R1',
    mode: 'pair',
    cmd: 'node -e "process.exit(0)"',
    mutant: 'node -e "process.exit(0)"',
  });
  assert.match(text, /证据收据未成立/);
  assert.match(text, /变异后仍然绿，这条闸门不会红/);
  assert.equal(h.read().items[0].evidence.at(-1).verified, false);
});

test('M1 receipt pair：基线红 + 变异绿 → 拒绝，理由是「基线本来就红，不能作为判据」', async () => {
  const h = host();
  await open(h, ['要求一']);
  const text = await h.call('ledger_receipt', {
    item: 'R1',
    mode: 'pair',
    cmd: 'node -e "process.exit(5)"',
    mutant: 'node -e "process.exit(0)"',
  });
  assert.match(text, /证据收据未成立/);
  assert.match(text, /基线本来就红，不能作为判据/);
  assert.equal(h.read().items[0].evidence.at(-1).verified, false);
});

test('M1 receipt pair：基线红 + 变异红 → 同样拒（先卡基线），且理由不含「成立」', async () => {
  const h = host();
  await open(h, ['要求一']);
  const text = await h.call('ledger_receipt', {
    item: 'R1',
    mode: 'pair',
    cmd: 'node -e "process.exit(5)"',
    mutant: 'node -e "process.exit(6)"',
  });
  assert.match(text, /证据收据未成立/);
  assert.match(text, /基线本来就红/);
  assert.equal(h.read().items[0].evidence.at(-1).verified, false);
});

test('M1 receipt：命令超时 → verified=false 且回执里标 timedOut', async () => {
  const h = host({ receipt: { enabled: true, timeoutMs: 150 } });
  await open(h, ['要求一']);
  const text = await h.call('ledger_receipt', { item: 'R1', cmd: 'node -e "setTimeout(()=>{}, 3000)"' });
  assert.match(text, /超时/);
  assert.match(text, /证据收据未成立/);
  const ev = h.read().items[0].evidence.at(-1);
  assert.equal(ev.verified, false);
  assert.equal(ev.receipt.timedOut, true);
});

test('M1 receipt：expectExit=1 时「恰好退出 1」才成立（期望值不是摆设）', async () => {
  const h = host();
  await open(h, ['要求一']);
  const ok = await h.call('ledger_receipt', { item: 'R1', cmd: 'node -e "process.exit(1)"', expectExit: 1 });
  assert.match(ok, /证据收据成立/);
  const bad = await h.call('ledger_receipt', { item: 'R1', cmd: 'node -e "process.exit(0)"', expectExit: 1 });
  assert.match(bad, /证据收据未成立/);
  const evs = h.read().items[0].evidence;
  assert.equal(evs.at(-2).verified, true);
  assert.equal(evs.at(-1).verified, false);
});

test('M1 receipt：失败的客观证据在 status 里不被写成「疑似自报」', async () => {
  const h = host();
  await open(h, ['要求一']);
  await h.call('ledger_receipt', { item: 'R1', cmd: 'node -e "process.exit(4)"' });
  const st = await h.call('ledger_status', {});
  assert.match(st, /插件自己执行但未通过（客观失败，不是自报）/);
  assert.doesNotMatch(st, /疑似自报证据/);
});

test('M1 receipt：receipt 不引入第二套 verdict（它只说读数，结论仍只由 ledger_check 出）', async () => {
  const h = host();
  await open(h, ['要求一']);
  const text = await h.call('ledger_receipt', { item: 'R1', cmd: 'node -e "process.exit(0)"' });
  assert.doesNotMatch(text, /verdict\s*:/, 'receipt 不应自己出 verdict');
  const chk = await h.call('ledger_check', {});
  assert.match(chk, /verdict: complete/, '唯一的收口出口仍然是 ledger_check');
});

test('M1 receipt：默认关 —— 拒绝且不写任何证据、账本内容不变', async () => {
  const h = host({ receipt: { enabled: false } });
  await open(h, ['要求一']);
  assert.ok(existsSync(h.ledgerFile), '先有账本文件可对照');
  const snapshot = h.read();
  const text = await h.call('ledger_receipt', { item: 'R1', cmd: 'node -e "process.exit(0)"' });
  assert.match(text, /证据收据未启用/);
  assert.match(text, /cordis\.patch\.yml/, '拒绝里要写清去哪个文件开启');
  assert.match(text, /receipt:\s*\n\s*enabled: true/, '拒绝里要给出可复制的配置片段');
  assert.match(text, /没有执行任何命令，也没有写入任何证据/);
  const after = h.read();
  assert.equal(after.items[0].evidence.length, 0, '默认关时不得写入证据');
  assert.equal(after.rev, snapshot.rev, '默认关时账本 rev 都不该变');
  assert.equal(after.updatedAt, snapshot.updatedAt, '默认关时账本内容完全不变');
  assert.equal(existsSync(join(h.dir, 'receipts.jsonl')), false, '默认关时不该产生 receipts.jsonl');
});

test('M1 receipt：显式开启后正常跑通（同一份账本，开关真的在起作用）', async () => {
  const offHost = host({ receipt: { enabled: false } });
  await open(offHost, ['要求一']);
  const off = await offHost.call('ledger_receipt', { item: 'R1', cmd: 'node -e "process.exit(0)"' });
  assert.match(off, /未启用/);
  assert.equal(offHost.read().items[0].evidence.length, 0);

  // 同一个账本目录、同一份契约，只把 receipt.enabled 打开 → 同一句调用就通了。
  const onCtx = makeFakeCtx();
  mod.apply(onCtx, { storageDir: offHost.dir, gateOnStop: 'off', receipt: { enabled: true } });
  const on = await onCtx._tools.get('ledger_receipt').execute({ item: 'R1', cmd: 'node -e "process.exit(0)"' }, offHost.exec);
  assert.match(on, /证据收据成立/);
  assert.equal(offHost.read().items[0].evidence.length, 1, '开启后才真的有证据落盘');
});

test('M1 receipt：verify.enabled=false 时 receipt 仍可用（与预注册的 ledger_verify 并存）', async () => {
  const h = host({ verify: { enabled: false, commands: [] } });
  assert.equal(h.tool('ledger_verify'), undefined, 'verify 未开启时不该有 ledger_verify');
  assert.ok(h.tool('ledger_receipt'), 'receipt 与 verify 开关无关');
  await open(h, ['要求一']);
  assert.match(await h.call('ledger_receipt', { item: 'R1', cmd: 'node -e "process.exit(0)"' }), /证据收据成立/);
});

test('M1 receipt：边界——缺 cmd / 未知 mode / 缺 mutant / 未知条目 都明确拒绝', async () => {
  const h = host();
  await open(h, ['要求一']);
  assert.match(await h.call('ledger_receipt', { item: 'R1', cmd: '  ' }), /没有给 cmd/);
  assert.match(await h.call('ledger_receipt', { item: 'R1', cmd: 'true', mode: 'flip' }), /只支持 run \| pair/);
  assert.match(await h.call('ledger_receipt', { item: 'R1', cmd: 'true', mode: 'pair' }), /需要同时给 cmd 与 mutant/);
  assert.match(await h.call('ledger_receipt', { item: 'R9', cmd: 'true' }), /没找到条目/);
  // 字符串会被宿主 schema 直接拒；走到工具体里的是「是 number 但不是整数」（如 1.5）——
  // 这一层若静默按 0 处理，判定会反了还看不出来。
  await assert.rejects(() => h.call('ledger_receipt', { item: 'R1', cmd: 'true', expectExit: '1' }));
  assert.match(await h.call('ledger_receipt', { item: 'R1', cmd: 'true', expectExit: 1.5 }), /expectExit 必须是整数/);
  // 缺必填 item 是**宿主 schema** 层的事（工具体根本不会被调用），这里钉住它确实会拒。
  await assert.rejects(() => h.call('ledger_receipt', { cmd: 'true' }));
});

/* ───────────── P0（独立评审）：客观证据不可被 kind 洗白 ───────────── */

test('P0：失败收据之后自报 kind=receipt → 入参即被拒（enum 闸），失败收据仍然算数', async () => {
  const h = host();
  await open(h, ['要求一']);
  await h.call('ledger_receipt', { item: 'R1', cmd: 'node -e "process.exit(7)"' });
  // kind 现在是 enum：receipt / oracle 这类保留值连宿主参数校验都过不去。
  await assert.rejects(() => h.call('ledger_evidence', { item: 'R1', kind: 'receipt', ref: 'node -e "process.exit(0)"' }));
  await assert.rejects(() => h.call('ledger_evidence', { item: 'R1', kind: 'oracle', ref: 'anything' }));
  const chk = await h.call('ledger_check', { claim: '做完了' });
  assert.match(chk, /verdict: incomplete/, '失败收据照样把条目拖在缺口里');
  assert.equal(h.read().items[0].evidence.length, 1, '被拒的自报证据没有落盘');
});

test('P0：即使伪造的 kind=receipt 证据已经躺在账本里（旧数据/绕过入口），check 仍不得 complete', async () => {
  const h = host();
  await open(h, ['要求一']);
  await h.call('ledger_receipt', { item: 'R1', cmd: 'node -e "process.exit(7)"' });
  // 模拟「绕过 enum 写进去的自报证据」：直接改账本文件（旧版本留下的数据也长这样）。
  const led = h.read();
  const real = led.items[0].evidence[0];
  assert.equal(real.pluginRun, true, '真收据带插件私有标记');
  led.items[0].evidence.push({ at: Date.now(), kind: 'receipt', ref: 'node -e "process.exit(0)"', verified: true, reason: '伪造' });
  writeFileSync(h.ledgerFile, JSON.stringify(led, null, 1), 'utf8');
  // 客观性只认 pluginRun：伪造那条不会被当成客观证据，更不会把失败洗成通过。
  assert.equal(mod.isObjectiveEvidence({ kind: 'receipt', verified: true }), false, 'kind=receipt 不再被认为是客观证据');
  assert.equal(mod.isObjectiveEvidence(real), true, 'pluginRun 才是客观证据');
  const chk = await h.call('ledger_check', { claim: '做完了' });
  assert.match(chk, /verdict: incomplete/, '洗白路径已断：check 必须仍是 incomplete');
  assert.doesNotMatch(chk, /可以宣称完成/);
});

test('P0：kind 白名单之外的任意值都被拒（枚举是契约，不是提示）', async () => {
  const h = host();
  await open(h, ['要求一']);
  for (const bad of ['receipt', 'oracle', 'self-report', 'COMMAND']) {
    await assert.rejects(() => h.call('ledger_evidence', { item: 'R1', kind: bad, ref: 'x' }), `${bad} 应被拒`);
  }
  assert.equal(h.read().items[0].evidence.length, 0);
});

/* ───────────── P1-1：收口后不能再追加契约 ───────────── */

test('P1-1：收口后 ledger_open 被拒，items 长度与终态都不变', async () => {
  const h = host();
  await open(h, ['要求一']);
  await h.call('ledger_close', { outcome: 'dropped', reason: '不做了', items: [{ id: 'R1', why: '需求取消' }] });
  const before = h.read();
  const text = await h.call('ledger_open', { requirements: ['收口后追加的要求'] });
  assert.match(text, /已收口/);
  const after = h.read();
  assert.equal(after.items.length, before.items.length, 'items 长度不变');
  assert.equal(after.closed.items.length, 1);
  assert.equal(after.rev, before.rev, '被拒时不写账本');
});

/* ───────────── P1-2：dropped 必须给「所有未达成条目」why ───────────── */

test('P1-2：被客观证据打回的条目也必须给 why（不能以占位符进终态）', async () => {
  const h = host();
  await open(h, ['要求一', '要求二']);
  await finishManual(h, 'R1'); // R1 先算完成
  // 一条失败收据把 R1 从 done 打回缺口（状态仍是 done/evidenced，但核验判它未达成）
  await h.call('ledger_receipt', { item: 'R1', cmd: 'node -e "process.exit(9)"' });
  const short = await h.call('ledger_close', { outcome: 'dropped', reason: '不做了', items: [{ id: 'R2', why: '排期外' }] });
  assert.match(short, /拒绝收口（dropped）/);
  assert.match(short, /R1/, '被打回的 R1 必须出现在缺失清单里');
  assert.equal(h.read().closed, undefined, '被拒不落终态');

  const ok = await h.call('ledger_close', {
    outcome: 'dropped',
    reason: '不做了',
    items: [{ id: 'R1', why: '收据没过，先放弃' }, { id: 'R2', why: '排期外' }],
  });
  assert.match(ok, /已收口（dropped）/);
  const closed = h.read().closed;
  assert.equal(closed.items.length, 2);
  assert.ok(closed.items.every((it) => it.why && !it.why.includes('（未给 why）')), '终态里不许出现占位符理由');
});

/* ───────────── P1-3：变异没跑完不算红 ───────────── */

test('P1-3：变异命令不存在（127）→ 不算红，判不成立', async () => {
  const h = host();
  await open(h, ['要求一']);
  const text = await h.call('ledger_receipt', {
    item: 'R1',
    mode: 'pair',
    cmd: 'node -e "process.exit(0)"',
    mutant: 'definitely-not-a-command-m16',
  });
  assert.match(text, /证据收据未成立/);
  assert.match(text, /变异没跑完/);
  assert.match(text, /127/);
  const ev = h.read().items[0].evidence.at(-1);
  assert.equal(ev.verified, false);
  assert.equal(ev.receipt.pair.mutant.exitCode, 127);
});

test('P1-3：变异超时 → 也不算红（超时不是「闸门变红」）', async () => {
  const h = host({ receipt: { enabled: true, timeoutMs: 150 } });
  await open(h, ['要求一']);
  const text = await h.call('ledger_receipt', {
    item: 'R1',
    mode: 'pair',
    cmd: 'node -e "process.exit(0)"',
    mutant: 'node -e "setTimeout(()=>{}, 3000)"',
  });
  assert.match(text, /证据收据未成立/);
  assert.match(text, /变异没跑完/);
  assert.equal(h.read().items[0].evidence.at(-1).verified, false);
});

/* ───────────── P1-4：执行目录收敛 + 尾部默认不留 ───────────── */

test('P1-4：默认 cwdScope=workspace —— 拿不到会话 cwd 就拒跑；设 any 才放行', async () => {
  const h = host();
  await open(h, ['要求一']);
  // 只有 agent.cwd、没有 session.header.cwd：无法证明落在 workspace 内
  // 复用同一个 session id（同一份账本），只是故意不带 header.cwd
  const sid = h.exec.agent.session.id;
  const bare = { agent: { session: { id: sid, snapshotEvents: () => [] }, cwd: h.cwd } };
  const refused = await h.tool('ledger_receipt').execute({ item: 'R1', cmd: 'node -e "process.exit(0)"' }, bare);
  assert.match(refused, /无法证明执行目录在 workspace 内/);
  assert.equal(h.read().items[0].evidence.length, 0, '拒跑时不得写证据');

  const anyCtx = makeFakeCtx();
  mod.apply(anyCtx, { storageDir: h.dir, gateOnStop: 'off', receipt: { enabled: true, cwdScope: 'any' } });
  const ok = await anyCtx._tools.get('ledger_receipt').execute({ item: 'R1', cmd: 'node -e "process.exit(0)"' }, bare);
  assert.match(ok, /证据收据成立/, 'cwdScope=any 时按 agent.cwd 跑');
});

test('P1-4：cwd 必须是绝对路径；执行目录在树外 → 拒跑（判据是 target，不是字面差异）', async () => {
  const h = host();
  await open(h, ['要求一']);
  const sid = h.exec.agent.session.id;
  const relExec = { agent: { session: { id: sid, header: { cwd: 'relative/dir' }, snapshotEvents: () => [] }, cwd: 'relative/dir' } };
  assert.match(await h.tool('ledger_receipt').execute({ item: 'R1', cmd: 'true' }, relExec), /不是绝对路径/);

  // 复审 P2-1：只有**实际执行目录**落在会话 cwd 之外才拒。这里 agent.cwd 在树外 → 拒。
  const other = mkdtempSync(join(tmpdir(), 'dsh-ledger-outsider-'));
  const splitExec = { agent: { session: { id: sid, header: { cwd: h.cwd }, snapshotEvents: () => [] }, cwd: other } };
  assert.match(await h.tool('ledger_receipt').execute({ item: 'R1', cmd: 'true' }, splitExec), /不在会话工作目录/);
  assert.equal(h.read().items[0].evidence.length, 0, '树外拒跑不得写证据');
});

test('P2-1：agent.cwd 是会话 cwd 的子目录 → 放行（只 warn 一次），回执记下真实执行目录', async () => {
  const h = host();
  await open(h, ['要求一']);
  const sub = join(h.cwd, 'packages', 'sub');
  mkdirSync(sub, { recursive: true });
  const sid = h.exec.agent.session.id;
  const subExec = { agent: { session: { id: sid, header: { cwd: h.cwd }, snapshotEvents: () => [] }, cwd: sub } };

  const text = await h.tool('ledger_receipt').execute({ item: 'R1', cmd: 'pwd' }, subExec);
  assert.match(text, /证据收据成立/, '子目录执行是正常的，不该被判成「歧义」');
  const ev = h.read().items[0].evidence.at(-1);
  // 记的是 realpath（macOS 上 /var 是 /private/var 的符号链接），只断言它指向那个子目录。
  assert.ok(ev.receipt.cwd.endsWith(join('packages', 'sub')), `回执要记下真实执行目录（实际 ${ev.receipt.cwd}）`);
  assert.ok(isAbsolute(ev.receipt.cwd));

  // 再调一次：日志里的提示只该有一条（warn 一次，不刷屏）
  await h.tool('ledger_receipt').execute({ item: 'R1', cmd: 'pwd' }, subExec);
  const warns = h.ctx._logs.filter((m) => String(m).includes('子目录执行'));
  assert.equal(warns.length, 1, `子目录提示应只出现一次（实际 ${warns.length}）`);
});

test('P1-4：stdout/stderr 尾部默认不落盘（receipt.tailChars 默认 0），opt-in 才留', async () => {
  const h = host();
  await open(h, ['要求一']);
  await h.call('ledger_receipt', { item: 'R1', cmd: 'node -e "console.log(\'SECRET-TAIL\')"' });
  const ev = h.read().items[0].evidence.at(-1);
  assert.equal(ev.receipt.outputTail, '', '默认不回执输出尾部');
  const lines = readFileSync(join(h.dir, 'receipts.jsonl'), 'utf8').trim().split('\n');
  const rec = JSON.parse(lines.at(-1));
  assert.equal(rec.baseline.stdoutTail, undefined, 'receipts.jsonl 里默认没有 stdoutTail');
  assert.equal(rec.baseline.stderrTail, undefined);
  assert.equal(rec.baseline.cmd, 'node -e "console.log(\'SECRET-TAIL\')"', '命令原文仍保留（可审）');

  const h2 = host({ receipt: { enabled: true, tailChars: 400 } });
  await open(h2, ['要求一']);
  await h2.call('ledger_receipt', { item: 'R1', cmd: 'node -e "console.log(\'TAIL-ON\')"' });
  assert.match(h2.read().items[0].evidence.at(-1).receipt.outputTail, /TAIL-ON/);
});

/* ────────────────────────── M3 主矛盾钉住 ────────────────────────── */

test('M3 pin：钉住后 ledger_check 不得 complete，理由里带矛盾 id 与 statement', async () => {
  const h = host();
  await open(h, ['要求一']);
  await finishManual(h, 'R1');
  assert.match(await h.call('ledger_check', {}), /verdict: complete/, '前提：未钉之前是 complete');

  const pin = await h.call('ledger_pin', { action: 'pin', statement: 'README 与实现不一致', why: '用户可见的行为有两套说法' });
  assert.match(pin, /已钉住主矛盾 X1/);

  const chk = await h.call('ledger_check', { claim: '做完了' });
  assert.match(chk, /verdict: incomplete/);
  assert.match(chk, /CONTRADICTION:X1/);
  assert.match(chk, /README 与实现不一致/);
  assert.doesNotMatch(chk, /可以宣称完成/);
});

test('M3 pin：已有未解除矛盾时再 pin 被拒（必须先 resolve 或 unpin）', async () => {
  const h = host();
  await open(h, ['要求一']);
  await h.call('ledger_pin', { action: 'pin', statement: '矛盾 A' });
  const again = await h.call('ledger_pin', { action: 'pin', statement: '矛盾 B' });
  assert.match(again, /已有未解除的主矛盾（X1）/);
  assert.equal(h.read().contradiction.statement, '矛盾 A', '账本里仍然只有原来那条');
});

test('M3 pin/unpin：unpin 必须带 reason；解除后 check 恢复 complete 且历史不丢', async () => {
  const h = host();
  await open(h, ['要求一']);
  await finishManual(h, 'R1');
  await h.call('ledger_pin', { action: 'pin', statement: '矛盾 A' });

  assert.match(await h.call('ledger_pin', { action: 'unpin' }), /必须给 reason/);
  assert.match(await h.call('ledger_pin', { action: 'unpin', reason: '钉错了：说的不是这条需求' }), /已撤销钉住/);
  assert.match(await h.call('ledger_check', {}), /verdict: complete/);

  // 解除后再钉，旧的那条进历史（账本读起来仍是一条，但审计链不断）
  await h.call('ledger_pin', { action: 'pin', statement: '矛盾 B' });
  const led = h.read();
  assert.equal(led.contradiction.id, 'X2');
  assert.equal(led.contradictionHistory.length, 1);
  assert.equal(led.contradictionHistory[0].id, 'X1');
  assert.equal(led.contradictionHistory[0].unpinned, true);
});

test('M3 pin：边界——缺 statement / 未知 action / 没有矛盾时 resolve 都明确拒绝', async () => {
  const h = host();
  await open(h, ['要求一']);
  assert.match(await h.call('ledger_pin', { action: 'pin', statement: '  ' }), /pin 需要 statement/);
  assert.match(await h.call('ledger_pin', { action: 'resolve' }), /当前没有未解除的主矛盾/);
  assert.match(await h.call('ledger_pin', { action: 'nope' }), /只支持 pin \| resolve \| unpin/);
  await h.call('ledger_pin', { action: 'pin', statement: '矛盾 A' });
  assert.match(await h.call('ledger_pin', { action: 'resolve' }), /resolve 需要 resolution/);
  assert.match(await h.call('ledger_pin', { action: 'resolve', resolution: '改掉了 README 第 12 行' }), /已解除/);
  assert.equal(mod.activeContradiction(h.read()), null);
});

/* ────────────────────────── M6 终态收口 ────────────────────────── */

test('M6 close achieved：核验不是 complete 就拒绝，并列出还差什么', async () => {
  const h = host();
  await open(h, ['要求一', '要求二']);
  await finishManual(h, 'R1');
  const text = await h.call('ledger_close', { outcome: 'achieved', reason: '都做完了' });
  assert.match(text, /拒绝收口（achieved）/);
  assert.match(text, /verdict: incomplete|当前核验是 incomplete/);
  assert.match(text, /R2/);
  assert.equal(h.read().closed, undefined, '被拒时不得留下终态');
});

test('M6 close achieved：全部有据 → 写终态，status 显示 achieved', async () => {
  const h = host();
  await open(h, ['要求一']);
  await finishManual(h, 'R1');
  const text = await h.call('ledger_close', { outcome: 'achieved', reason: '证据齐全' });
  assert.match(text, /已收口（achieved）/);
  const led = h.read();
  assert.equal(led.closed.outcome, 'achieved');
  assert.equal(led.closed.reason, '证据齐全');
  assert.ok(Array.isArray(led.closed.items) && led.closed.items.length === 1);
  assert.match(await h.call('ledger_status', {}), /终态：achieved/);
  assert.match(await h.call('ledger_check', {}), /账本已收口（achieved/);
});

test('M6 close dropped：缺 why 即拒绝并列出缺的条目 id；补齐后落终态', async () => {
  const h = host();
  await open(h, ['要求一', '要求二']);
  const short = await h.call('ledger_close', {
    outcome: 'dropped',
    reason: '需求取消',
    items: [{ id: 'R1', why: '已由另一需求覆盖' }],
  });
  assert.match(short, /拒绝收口（dropped）/);
  assert.match(short, /R2/);
  assert.equal(h.read().closed, undefined);

  const ok = await h.call('ledger_close', {
    outcome: 'dropped',
    reason: '需求取消',
    items: [{ id: 'R1', why: '已由另一需求覆盖' }, { id: 'R2', why: '排期外，暂不做' }],
  });
  assert.match(ok, /已收口（dropped）/);
  const led = h.read();
  assert.equal(led.closed.outcome, 'dropped');
  assert.equal(led.closed.items.length, 2);
  assert.match(await h.call('ledger_status', {}), /终态：dropped/);
});

test('M6 close：收口后 evidence / receipt / pin 一律拒绝，且终态只能写一次', async () => {
  const h = host();
  await open(h, ['要求一']);
  await h.call('ledger_close', { outcome: 'dropped', reason: '不做了', items: [{ id: 'R1', why: '需求取消' }] });

  const ev = await h.call('ledger_evidence', { item: 'R1', kind: 'manual', ref: '补一条' });
  assert.match(ev, /已收口/);
  const rc = await h.call('ledger_receipt', { item: 'R1', cmd: 'node -e "process.exit(0)"' });
  assert.match(rc, /已收口/);
  const pin = await h.call('ledger_pin', { action: 'pin', statement: '收口后再钉' });
  assert.match(pin, /已收口/);
  const again = await h.call('ledger_close', { outcome: 'achieved', reason: '再来一次' });
  assert.match(again, /终态只写一次/);
  assert.equal(h.read().items[0].evidence.length, 0, '拒绝之后账本真的没变');
});

test('M6 close：边界——未知 outcome / 缺 reason / 缺必填 outcome 都明确拒绝', async () => {
  const h = host();
  await open(h, ['要求一']);
  assert.match(await h.call('ledger_close', { outcome: 'done', reason: 'x' }), /只能是 achieved \| dropped/);
  assert.match(await h.call('ledger_close', { outcome: 'achieved', reason: '   ' }), /必须给 reason/);
  await assert.rejects(() => h.call('ledger_close', { reason: '缺 outcome' }));
});

test('M6 close：主矛盾未解除时 achieved 被拒（终态不能绕过矛盾）', async () => {
  const h = host();
  await open(h, ['要求一']);
  await finishManual(h, 'R1');
  await h.call('ledger_pin', { action: 'pin', statement: '矛盾 A' });
  const text = await h.call('ledger_close', { outcome: 'achieved', reason: '都做完了' });
  assert.match(text, /拒绝收口（achieved）/);
  assert.match(text, /CONTRADICTION:X1/);
});

/* ───────────────────── 跨机制：终态抑制收尾门禁 ───────────────────── */

test('M6 close：收口后 turn-stopping 不再唠叨（dropped 的 open 条目不会永远拉回一步）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ledger-m16-stop-'));
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-ledger-cwd-stop-'));
  const ctx = makeFakeCtx();
  mod.apply(ctx, { storageDir: dir, gateOnStop: 'remind' });
  const session = { id: 'm16-stop', header: { cwd }, snapshotEvents: () => [] };
  const injected = [];
  const agent = { session, cwd, inject: (m) => injected.push(m) };
  const exec = { agent };
  const T = ctx._tools;
  await T.get('ledger_open').execute({ requirements: ['要求一'] }, exec);
  const stop = ctx._hooks.get('agent/turn-stopping')[0];
  // 门禁刻意「本轮啥也没干就别唠叨」：先记一条真实工具活动，否则它本来就不该提醒。
  await ctx._hooks.get('tools/post-execute')[0](
    { name: 'bash', arguments: { command: 'node -e "process.exit(0)"' }, agent },
    {},
    async () => ({ kind: 'accept', content: [{ type: 'text', text: 'ok' }] }),
  );

  await stop({ agent, turn: 1 });
  assert.equal(injected.length, 1, '未收口时会计入提醒');
  injected.length = 0;
  await T.get('ledger_close').execute({ outcome: 'dropped', reason: '需求取消', items: [{ id: 'R1', why: '取消' }] }, exec);
  await stop({ agent, turn: 2 });
  assert.equal(injected.length, 0, '已收口（终态）后不该再被「还没收口」拉回');
});
