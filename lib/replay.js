/**
 * 从**持久会话日志**重放工具活动（纯函数）。
 *
 * 为什么要有这一层（参照 dsh-doublecheck 的做法）：它把门禁事实完全建立在持久会话日志上，
 * 于是「重放即状态」——恢复、分叉、中途装载插件、宿主重启后拿到的事实都一样，也不依赖
 * 任何额外服务 API。本插件原先只有 `tools/post-execute` 的内存观察，插件晚装一步就永远
 * 少一段事实；这里补上。
 *
 * 行类型与形态（实测自本机 `session.v4.jsonl.zstd`）：
 *  - `tool/call`   → `data.{turn,step,callId,name,arguments}`，`arguments` 是 **JSON 字符串**
 *  - `tool/result` → `data.{turn,step,message.{role:'tool',source:{kind:'tool',callId},toolCallId,content}}`
 *  - 旧形态：工具结果可能以 `user/message` 出现且 `message.source.kind === 'tool'`（读侧一并认）
 */
import { createHash } from 'node:crypto';
import { dataOf, seqOf, typeOf } from './compat/index.js';

/** 与 index.js 保持同一套「验证类工具」判据；replay 出的条目也带这个标记。 */
export const VERIFYING_TOOL_RE = /^(bash|run_code|lint_|browser_|test|tracescope_)/;

const textOfContent = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
};

/** 有限的时间戳；缺失或不合法时退化为 0（而不是 NaN 或 Date.now()，后者会让重放不可复现）。 */
export function finiteTime(value, seq) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;
  return Number.isFinite(seq) ? seq : 0;
}

/** 从工具参数里取「这次动作做了什么」：优先命令原文，否则压平的 JSON。 */
export function detailOfArguments(argsRaw, opts = {}) {
  if (argsRaw === null || argsRaw === undefined) return '';
  let obj = argsRaw;
  if (typeof argsRaw === 'string') {
    const s = argsRaw.trim();
    if (s === '') return '';
    try {
      obj = JSON.parse(s);
    } catch {
      return s.slice(0, 200);
    }
  }
  const cut = opts.full === true ? Number.POSITIVE_INFINITY : 200;
  if (obj && typeof obj === 'object') {
    const pick = obj.command ?? obj.cmd ?? obj.path ?? obj.file_path ?? obj.query;
    if (typeof pick === 'string' && pick !== '') return pick.replace(/\s+/g, ' ').slice(0, cut);
    try {
      return JSON.stringify(obj).replace(/\s+/g, ' ').slice(0, cut);
    } catch {
      return '';
    }
  }
  return String(obj).slice(0, cut);
}

/**
 * 工具结果里的失败信号。
 *
 * 实测（40 个真实会话、3981 条 tool/result）：带 `[exit code: N]` 的只有 82 条，且取值几乎全是
 * 非零（1/2/7/9/28/127/255）——**宿主只在非零退出时附该标记**，所以「没标记」对 bash 等于成功，
 * 但对 edit/write/web_fetch 这类工具，失败只会体现在文本里（`Error:` / 被拒绝 / 沙箱拒绝）。
 * 没有这层判断时，失败会被渲染成 ✓。
 */
const FAILURE_TEXT_RE =
  /^(?:Error:|error:|fatal:|\[stderr\])|the user rejected tool|sandbox: file access denied|has not been read|Command failed|tool call aborted/i;

export function looksLikeFailure(text) {
  return FAILURE_TEXT_RE.test(String(text ?? '').trim());
}

/**
 * 从工具结果文本里读退出码。
 *
 * 取**最后一个**匹配：命令正文里完全可能打印过 `[exit code: 0]` 这样的字面量，
 * 若取第一个就会把真正尾部的失败标记吞掉（实测该方向可把失败翻成成功）。
 */
export function exitCodeOf(text) {
  const s = String(text ?? '');
  let last = null;
  for (const m of s.matchAll(/\[exit code:\s*(-?\d+)\]/gi)) last = m[1];
  return last === null ? null : Number(last);
}

/**
 * 活动条目的稳定身份：有 callId 用它（重放与落盘两侧就能对上），否则用
 * 「名字 + 完整 detail + 秒级时间桶」的哈希——detail 在展示层会被截断，
 * 所以哈希要在截断**之前**算，避免两条不同的长命令被当成同一条。
 */
export function entryKey({ callId, name, detail, at } = {}) {
  if (callId) return `c:${callId}`;
  const basis = `${name ?? ''}\u0000${detail ?? ''}\u0000${Math.floor(Number(at ?? 0) / 1000)}`;
  return `h:${createHash('sha1').update(basis).digest('hex').slice(0, 16)}`;
}

/** 该行是否是一条工具结果（认 V4 tool 角色与旧版 user 消息两种形态）。 */
export function isToolResultRow(type, data) {
  if (type === 'tool/result') return true;
  if (type !== 'user/message' && type !== 'message') return false;
  const msg = data?.message;
  return msg?.source?.kind === 'tool' || typeof msg?.toolCallId === 'string';
}

/**
 * 把会话事件折成活动列表。
 *
 * @param events - 会话事件行（`compat.eventsOf(session)` 的产物）。
 * @param opts.limit - 只保留最近多少条（默认 50）。
 * @param opts.sinceSeq - 只重放该序号之后的行（增量重放用；默认不限制）。
 * @param opts.sinceTime - 只重放该时刻之后发生的调用（按**证据时间**回看用的下界；
 *   默认不限制。只按「最近 N 条」裁剪会让长会话里早期挂的证据全被判成自报，见 README 已知边界）。
 * @returns `{ at, name, ok, exitCode, detail, note, verifying, callId, seq, replayed: true }[]`
 */
export function replayActivity(events, opts = {}) {
  const limit = Math.max(1, Number(opts.limit) || 50);
  const sinceSeq = Number.isFinite(opts.sinceSeq) ? opts.sinceSeq : -1;
  const sinceTime = Number.isFinite(opts.sinceTime) ? opts.sinceTime : Number.NEGATIVE_INFINITY;
  const calls = new Map();
  const results = [];
  for (const ev of Array.isArray(events) ? events : []) {
    const seq = seqOf(ev);
    if (seq !== null && seq <= sinceSeq) continue;
    const type = typeOf(ev);
    const data = dataOf(ev);
    if (type === 'tool/call') {
      // callId 缺失时不要整条丢弃（那会让本来能支撑证据的动作凭空消失），用 seq 兜底并标记。
      const rawCallId = String(data?.callId ?? data?.id ?? '');
      const callId = rawCallId !== '' ? rawCallId : seq !== null ? `seq:${seq}` : '';
      if (callId === '') continue;
      const detailFull = detailOfArguments(data?.arguments, { full: true });
      const at = finiteTime(data?.time ?? ev?.time, seq);
      if (at < sinceTime) continue;
      calls.set(callId, {
        callId,
        callIdMissing: rawCallId === '',
        name: String(data?.name ?? '?'),
        detail: detailFull.slice(0, 200),
        detailFull,
        // 时间必须是有限数：NaN 会让条目掉出比对的时间窗、并让去重键互相塌缩。
        at,
        seq,
      });
      continue;
    }
    if (isToolResultRow(type, data)) {
      const msg = data?.message ?? {};
      const callId = String(data?.toolCallId ?? msg?.toolCallId ?? msg?.source?.callId ?? '');
      const text = textOfContent(msg?.content ?? data?.content);
      results.push({ callId, text, at: Number(ev?.time ?? Date.now()), seq });
    }
  }
  const byCall = new Map();
  for (const r of results) {
    const prev = byCall.get(r.callId);
    if (!prev) {
      byCall.set(r.callId, r);
      continue;
    }
    // 同一 callId 出现多条结果是常态（实测本机日志里 compaction/prune 会重发裁剪副本，
    // 19 个 callId 命中）。原来「最后一条胜出」会把前一条的失败标记吞掉 → 这里改成保守合并：
    // 任一副本显示失败，就以失败为准；都正常才取「信息更全」的那条。
    const anyFailure = looksLikeFailure(prev.text) || looksLikeFailure(r.text);
    const prevHasCode = exitCodeOf(prev.text) !== null;
    const curHasCode = exitCodeOf(r.text) !== null;
    const better = (!prevHasCode && curHasCode) || (prevHasCode === curHasCode && r.text.length > prev.text.length);
    byCall.set(r.callId, {
      ...(better ? r : prev),
      text: anyFailure ? `${prev.text}\n${r.text}` : better ? r.text : prev.text,
    });
  }
  const out = [];
  for (const c of calls.values()) {
    const r = byCall.get(c.callId);
    const exitCode = r ? exitCodeOf(r.text) : null;
    const failedByText = r ? looksLikeFailure(r.text) : false;
    // ok 是三态：true 有据可依 / false 明确失败 / null 无从判定（连结果行都没有）。
    const ok = r === undefined ? null : exitCode !== null ? exitCode === 0 : failedByText ? false : true;
    const okSource =
      r === undefined ? 'no-result' : exitCode !== null ? 'exit-code' : failedByText ? 'error-text' : 'no-marker';
    out.push({
      at: c.at,
      seq: c.seq,
      callId: c.callId,
      name: c.name,
      detail: c.detail,
      callIdMissing: c.callIdMissing === true,
      detailFull: c.detailFull ?? c.detail,
      ok,
      okSource,
      exitCode,
      note: String(r?.text ?? '').replace(/\s+/g, ' ').slice(0, 100),
      verifying: VERIFYING_TOOL_RE.test(c.name),
      replayed: true,
      key: entryKey({ callId: c.callId, name: c.name, detail: c.detailFull ?? c.detail, at: c.at }),
    });
  }
  out.sort((a, b) => a.at - b.at);
  return out.length > limit ? out.slice(out.length - limit) : out;
}

/**
 * 合并「重放事实 / 落盘活动 / 内存观察」，按 callId（无则按 时间+名字+detail）去重。
 * 重放优先（它来自持久日志，最可信），其余只补重放里没有的。
 */
export function mergeActivity(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const a of Array.isArray(list) ? list : []) {
      if (!a || typeof a !== 'object') continue;
      // 注意优先级：必须写成 a.key ?? (三元)，否则 `a.key ?? a.callId ? …` 会先做真值合并。
      const key = a.key ?? (a.callId ? `c:${a.callId}` : entryKey(a));
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(a);
    }
  }
  out.sort((a, b) => Number(a.at ?? 0) - Number(b.at ?? 0));
  return out;
}
