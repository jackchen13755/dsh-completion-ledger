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

/** 从工具参数里取「这次动作做了什么」：优先命令原文，否则压平的 JSON。 */
export function detailOfArguments(argsRaw) {
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
  if (obj && typeof obj === 'object') {
    const pick = obj.command ?? obj.cmd ?? obj.path ?? obj.file_path ?? obj.query;
    if (typeof pick === 'string' && pick !== '') return pick.replace(/\s+/g, ' ').slice(0, 200);
    try {
      return JSON.stringify(obj).replace(/\s+/g, ' ').slice(0, 200);
    } catch {
      return '';
    }
  }
  return String(obj).slice(0, 200);
}

/** 从工具结果文本里读退出码（宿主 bash 工具的输出约定：`[exit code: N]`）。 */
export function exitCodeOf(text) {
  const m = /\[exit code:\s*(-?\d+)\]/i.exec(String(text ?? ''));
  return m ? Number(m[1]) : null;
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
 * @returns `{ at, name, ok, exitCode, detail, note, verifying, callId, seq, replayed: true }[]`
 */
export function replayActivity(events, opts = {}) {
  const limit = Math.max(1, Number(opts.limit) || 50);
  const sinceSeq = Number.isFinite(opts.sinceSeq) ? opts.sinceSeq : -1;
  const calls = new Map();
  const results = [];
  for (const ev of Array.isArray(events) ? events : []) {
    const seq = seqOf(ev);
    if (seq !== null && seq <= sinceSeq) continue;
    const type = typeOf(ev);
    const data = dataOf(ev);
    if (type === 'tool/call') {
      const callId = String(data?.callId ?? '');
      if (callId === '') continue;
      calls.set(callId, {
        callId,
        name: String(data?.name ?? '?'),
        detail: detailOfArguments(data?.arguments),
        at: Number(data?.time ?? ev?.time ?? Date.now()),
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
    if (!prev || r.at >= prev.at) byCall.set(r.callId, r);
  }
  const out = [];
  for (const c of calls.values()) {
    const r = byCall.get(c.callId);
    const exitCode = r ? exitCodeOf(r.text) : null;
    out.push({
      at: c.at,
      seq: c.seq,
      callId: c.callId,
      name: c.name,
      detail: c.detail,
      ok: exitCode === null ? true : exitCode === 0,
      exitCode,
      note: String(r?.text ?? '').replace(/\s+/g, ' ').slice(0, 100),
      verifying: VERIFYING_TOOL_RE.test(c.name),
      replayed: true,
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
      const key = a.callId ? `c:${a.callId}` : `t:${a.at}|${a.name}|${a.detail ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(a);
    }
  }
  out.sort((a, b) => Number(a.at ?? 0) - Number(b.at ?? 0));
  return out;
}
