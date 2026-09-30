/**
 * 宿主差异层（compat）—— 所有版本相关判断只此一处。
 *
 * 三条规矩（分别来自 dsh-doublecheck 与 dsh-pua 的实测经验）：
 *  1. **只认持久会话日志**：事实从 `tool/call` / `tool/result` / `turn/*` 这些宿主保证的
 *     行类型里重放，不依赖任何额外服务 API——这是最抗宿主升级的取数方式。
 *  2. **读侧认多种形态，写侧只写当前形态**：读事件时同时接受 `snapshotEvents()` /
 *     `events` / `ownEvents()` 与「工具结果是 V4 的 tool 角色 / 旧版包在 user 消息里」两种形态；
 *     写信（回注消息）永远只按当前宿主的 `MessageSource` 契约写一次（见 index.js 的 reinjectMessage）。
 *  3. **版本判定用宿主导出的常量**，不用 try/catch 试探后重试：优先读
 *     `@deepseek-ai/dsh-session` 的 `SESSION_FORMAT_VERSION`；拿不到常量时退化为**形态识别**
 *     （对同一份数据两种形态都试读，但只做一次、结果缓存），不做「失败就重写」式的试探。
 *
 * 这一层刻意不新增硬 peer：版本常量是**可选增强**（动态 import 一次并缓存），
 * 缺失时行为确定可预期——插件仍能装载，只是少一条版本日志。
 */

/** 事件行的通用形状（宿主会话格式；V4 起带 seq/time/data）。 */
const rowOf = (e) => (e && typeof e === 'object' ? e : null);

/** 事件类型（兼容 `type` 缺失但有 `data.type` 的旧行）。 */
export function typeOf(event) {
  const row = rowOf(event);
  if (!row) return '';
  if (typeof row.type === 'string' && row.type !== '') return row.type;
  if (typeof row.data?.type === 'string') return row.data.type;
  return '';
}

/** 事件载荷。 */
export function dataOf(event) {
  const row = rowOf(event);
  return row && typeof row.data === 'object' && row.data !== null ? row.data : {};
}

/** 事件序号（V4 有 seq；旧格式没有则返回 null）。 */
export function seqOf(event) {
  const n = rowOf(event)?.seq;
  return Number.isFinite(n) ? n : null;
}

/**
 * 取一个会话的全部事件行——读侧认三种形态，**顺序固定、只读一次**。
 *
 * 优先级：`snapshotEvents()`（rc.1+ 的公开 API）→ `events`（数组属性）→
 * `ownEvents()`（pua 在用的形态）。三者都拿不到就返回空数组，由调用方按「无事实」处理，
 * 绝不把「拿不到」解释成「没有活动」。
 */
export function eventsOf(session) {
  if (!session || typeof session !== 'object') return [];
  const attempts = ['snapshotEvents', 'ownEvents'];
  for (const fn of attempts) {
    if (typeof session[fn] === 'function') {
      try {
        const out = session[fn]();
        if (Array.isArray(out)) return out;
      } catch {
        // 形态不匹配（不是「重试」）：继续看下一个形态，最后统一返回空数组。
      }
    }
  }
  if (Array.isArray(session.events)) return session.events;
  return [];
}

/** 会话格式版本（宿主导出的常量；拿不到返回 null）。 */
let versionPromise = null;
export function sessionFormatVersion() {
  if (versionPromise === null) {
    versionPromise = import('@deepseek-ai/dsh-session')
      .then((m) => (Number.isFinite(m?.SESSION_FORMAT_VERSION) ? m.SESSION_FORMAT_VERSION : null))
      .catch(() => null);
  }
  return versionPromise;
}

/** 兼容层自述（供 ledger_status / 日志回答「你现在按哪种形态在跑」）。 */
export async function compatReport(session) {
  const events = eventsOf(session);
  return {
    sessionFormatVersion: await sessionFormatVersion(),
    events: events.length,
    eventsSource: typeof session?.snapshotEvents === 'function' ? 'snapshotEvents()' : Array.isArray(session?.events) ? 'events' : typeof session?.ownEvents === 'function' ? 'ownEvents()' : '（无）',
  };
}
