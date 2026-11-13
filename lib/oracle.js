/**
 * 验收命令的独立执行器（Oracle）。
 *
 * 为什么由**插件自己**跑：`ledger_evidence` 的比对只能证明「某个动作跑过」，
 * 证明不了「它通过了」。让插件自己执行、只认退出码，是唯一模型难以伪造的证据类。
 *
 * 纪律（与 `git-evidence.js` 同一套）：
 *  - **零宿主 API**：直接 `execFile('/bin/sh', ['-c', cmd])`，于是 smoke 不需要假宿主就能测。
 *  - **必须在会话 cwd 下执行**：拿不到 cwd 就拒绝，绝不落到插件进程自己的 cwd。
 *  - 环境变量**白名单**构造：不把宿主的 API key / 代理配置泄漏给验收命令；`PWD` 改写为真实 cwd。
 *    调用方唯一能加变量的口子是 `opts.env`（名字必须规范、值必须是 string，见 `sanitizeOracleEnv`），
 *    因为「这条命令要认哪个会话」这类信息本来就不在宿主的白名单里。
 *  - `detached: true` + 杀进程组：超时只杀 shell 会把子进程留成孤儿。
 *
 * 已知边界（如实写在代码里，不要以为它是安全边界）：
 *  - 它执行的是**当前工作区的代码**（`pnpm test` 读 package.json）。模型若能改 `package.json`
 *    里的脚本，就等于能改它执行的代码。因此「命令只能引用用户声明的 id」只挡住了命令自拟，
 *    挡不住「用户声明的命令所执行的脚本被改」——后者要靠 `verify.enabled` 的启用决策来权衡。
 */
import { execFile } from 'node:child_process';

/**
 * 调用方额外透传的环境变量名必须长这样。
 *
 * 只放 `^[A-Z_][A-Z0-9_]*$`：这是普通 POSIX 变量名的子集，能被 `/bin/sh` 与 cmd.exe
 * 一致接受；放过小写/连字符/点号会让「同一个键在不同 shell 里行为不同」，而且这些形状
 * 通常是调用方拼错了（`dsh_session_id`、`DSH-SESSION-ID`）。
 */
const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;

/**
 * `PWD` 由 runOracle 按真实 cwd 覆写，调用方不能改。
 * 允许覆盖会让「脚本按 $PWD 定位工作区」跳去别处，而这正是本文件开头要防的坑。
 */
const ENV_RESERVED = ['PWD'];

/** 允许透传给验收命令的环境变量（白名单，不是黑名单）。 */
const ENV_ALLOW = [
  // HOME 必须给：`git config --global`、多数测试框架的缓存都依赖它，缺了会给出假失败。
  // 代价是验收命令能读到 ~/.ssh、~/.aws —— 这也是「命令必须是用户自己声明」的现实理由之一。
  'HOME', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP',
  'SHELL', 'USER', 'LOGNAME', 'TERM', 'TZ',
  'SystemRoot', 'ComSpec', 'PATHEXT', 'SystemDrive', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
];

/**
 * 校验调用方额外透传的环境变量。
 *
 * 为什么要有出口：验收命令有时确实需要知道「这是哪一次会话」（例如
 * `dispatch-check` 要读**当前会话**的日志，而不是按 cwd 猜一个）。白名单挡不住这类
 * 需求，于是开一个**只能传字符串、名字必须规范**的小口子，而不是让调用方改白名单。
 *
 * 边界（都由用例钉住，不是注释承诺）：
 *  - `opts.env` 不是普通对象（数组 / 字符串 / 数字）→ **整体忽略**并告警；
 *  - `undefined` / `null` → 视为「没传」，不告警（可选参数不该惩罚默认路径）；
 *  - 键不匹配 `^[A-Z_][A-Z0-9_]*$` → 忽略该键并告警；
 *  - 值不是 string → 忽略该键并告警（不做 `String(v)` 强转：`undefined` 会变成字符串
 *    `'undefined'` 塞进子进程，比忽略更难查）；
 *  - 键是 `PWD` → 忽略并告警（真实 cwd 永远优先）。
 *
 * @returns {{accepted: Record<string,string>, warnings: string[]}}
 */
export function sanitizeOracleEnv(extra) {
  const accepted = {};
  const warnings = [];
  if (extra === undefined || extra === null) return { accepted, warnings };
  if (typeof extra !== 'object' || Array.isArray(extra)) {
    const shape = Array.isArray(extra) ? '数组' : typeof extra;
    warnings.push(`opts.env 必须是普通对象（收到 ${shape}），已整体忽略`);
    return { accepted, warnings };
  }
  for (const [k, v] of Object.entries(extra)) {
    if (ENV_RESERVED.includes(k)) {
      warnings.push(`忽略 opts.env.PWD：它由 runOracle 按真实 cwd 覆写（否则脚本按 $PWD 会跑错目录）`);
      continue;
    }
    if (!ENV_KEY_RE.test(k)) {
      warnings.push(`忽略非法变量名 ${JSON.stringify(k)}：必须匹配 ^[A-Z_][A-Z0-9_]*$`);
      continue;
    }
    if (typeof v !== 'string') {
      warnings.push(`忽略 ${k}：值必须是 string（收到 ${v === null ? 'null' : typeof v}）`);
      continue;
    }
    accepted[k] = v;
  }
  return { accepted, warnings };
}

/**
 * 构造验收命令的环境变量。
 *
 * `PWD` 由调用方按**真实 cwd** 覆盖：继承来的 `PWD` 是插件进程的目录，
 * 脚本若按 `$PWD` 定位会跑错目录。
 *
 * @param cwd - 会话工作目录（写成 `PWD`）。
 * @param base - 继承来源，默认 `process.env`（白名单只从这里取）。
 * @param extra - 调用方额外透传的键值；已按 {@link sanitizeOracleEnv} 的规则过滤，
 *   同名键**覆盖**白名单值（白名单是「允许继承」，不是「只能这些值」）。
 */
export function oracleEnv(cwd = '', base = process.env, extra = undefined) {
  const env = {};
  for (const k of ENV_ALLOW) if (base?.[k] !== undefined) env[k] = base[k];
  if (typeof cwd === 'string' && cwd !== '') env.PWD = cwd;
  const { accepted } = sanitizeOracleEnv(extra);
  for (const [k, v] of Object.entries(accepted)) env[k] = v;
  return env;
}

/**
 * 跑一条验收命令。
 *
 * @param command - shell 命令行（由用户声明，不是模型自拟）。
 * @param opts.cwd - 会话工作目录（必填；缺失即拒绝执行）。
 * @param opts.timeoutMs - 墙钟超时，默认 120s。**超时由定时器直接结算**，不等子进程退出。
 * @param opts.tailChars - stdout/stderr 各保留多少字符（输出是**数据**，不是指令）。
 * @param opts.signal - 中止信号；已中止则不执行，执行中被中止则杀组并按失败结算。
 * @param opts.env - 额外透传给验收命令的环境变量（只收 `^[A-Z_][A-Z0-9_]*$` + string 值；
 *   同名键覆盖白名单值）。非法条目**忽略并在 `envWarnings` 里说明**，不静默、也不因此整体失败。
 * @returns {Promise<{ok:boolean, exitCode:number|null, timedOut:boolean, aborted:boolean,
 *   signal:string|null, durationMs:number, stdoutTail:string, stderrTail:string, reason:string,
 *   envWarnings:string[]}>}
 */
export function runOracle(command, opts = {}) {
  const cwd = opts.cwd;
  const timeoutMs = Math.max(100, Number(opts.timeoutMs) || 120000);
  const tailChars = Math.max(200, Number(opts.tailChars) || 2000);
  // 先算一次告警：**任何**返回路径（含空命令/无 cwd/已中止）都要带上它，
  // 否则「opts.env 全是非法键」这种最容易踩的情况恰好不告警。
  const { warnings: envWarnings } = sanitizeOracleEnv(opts.env);
  const tail = (s) => {
    const text = String(s ?? '');
    return text.length > tailChars ? text.slice(text.length - tailChars) : text;
  };
  const started = Date.now();

  return new Promise((resolve) => {
    let settled = false;
    let child = null;
    let timer = null;
    let outBuf = '';
    let errBuf = '';
    const finish = (v) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ aborted: false, signal: null, envWarnings, ...v });
    };
    const killGroup = () => {
      if (!child) return;
      // 先断开 pipe，否则回调仍可能等 stdio EOF（`pnpm dev &` 这类后台进程会继承 pipe）。
      try { child.stdout?.destroy(); } catch { /* 尽力而为 */ }
      try { child.stderr?.destroy(); } catch { /* 尽力而为 */ }
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch { /* 尽力而为 */ }
      }
    };

    if (typeof command !== 'string' || command.trim() === '') {
      finish({ ok: false, exitCode: null, timedOut: false, durationMs: 0, stdoutTail: '', stderrTail: '', reason: '验收命令为空' });
      return;
    }
    if (typeof cwd !== 'string' || cwd === '') {
      finish({ ok: false, exitCode: null, timedOut: false, durationMs: 0, stdoutTail: '', stderrTail: '', reason: '没有会话工作目录，拒绝在插件进程的 cwd 下执行验收命令' });
      return;
    }
    const sig = opts.signal;
    if (sig?.aborted === true) {
      finish({ ok: false, exitCode: null, timedOut: false, aborted: true, durationMs: 0, stdoutTail: '', stderrTail: '', reason: '本轮已被中止，未执行验收命令' });
      return;
    }

    const win = process.platform === 'win32';
    const shell = win ? process.env.ComSpec || 'cmd.exe' : '/bin/sh';
    const shellArgs = win ? ['/d', '/s', '/c', command] : ['-c', command];

    try {
      child = execFile(shell, shellArgs, {
        cwd,
        env: oracleEnv(cwd, process.env, opts.env),
        detached: !win,          // 独立进程组：超时可以整组杀
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      }, (err, stdout, stderr) => {
        // stdio 超限时 err.code 是字符串（ERR_CHILD_PROCESS_STDIO_MAXBUFFER），别把它当退出码。
        const rawCode = err?.code;
        const exitCode = typeof rawCode === 'number' ? rawCode : settled ? null : err ? null : 0;
        const signal = err?.signal ?? null;
        // 只看退出码：超时、被信号杀、跑不起来，都不算通过。
        const ok = !settled && exitCode === 0 && (signal === null || signal === undefined);
        const reason = ok
          ? '退出码 0'
          : rawCode === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
            ? '输出超过 8MB 上限，按失败处理'
            : `退出码 ${exitCode === null ? '未知' : exitCode}${signal ? `，信号 ${signal}` : ''}`;
        finish({
          ok,
          exitCode,
          timedOut: false,
          signal,
          durationMs: Date.now() - started,
          stdoutTail: tail(stdout),
          stderrTail: tail(stderr),
          reason,
        });
      });
    } catch (err) {
      finish({ ok: false, exitCode: null, timedOut: false, durationMs: Date.now() - started, stdoutTail: '', stderrTail: '', reason: `启动失败：${String(err?.message ?? err).slice(0, 160)}` });
      return;
    }

    // 墙钟超时：**由定时器直接结算**。如果把「能返回结果」绑在子进程退出上，
    // 继承了 stdout pipe 的后台进程（`pnpm dev &`、watcher）会让它永不 resolve，
    // 而调用方是 await 在 turn-stopping 里的 —— 整个轮次就永久挂住。
    timer = setTimeout(() => {
      finish({
        ok: false,
        exitCode: null,
        timedOut: true,
        durationMs: Date.now() - started,
        // 超时前已经产生的输出是最需要的诊断信息，不能丢。
        stdoutTail: tail(outBuf),
        stderrTail: tail(errBuf),
        reason: `超时（>${timeoutMs}ms），按失败处理`,
      });
      killGroup();
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    // 累积输出：超时结算时要能带回「已经跑出来的那部分」。
    try {
      child?.stdout?.on('data', (d) => { outBuf = `${outBuf}${d.toString()}`.slice(-tailChars * 4); });
      child?.stderr?.on('data', (d) => { errBuf = `${errBuf}${d.toString()}`.slice(-tailChars * 4); });
    } catch { /* 拿不到流就只靠回调 */ }

    if (sig && typeof sig.addEventListener === 'function') {
      const onAbort = () => {
        finish({ ok: false, exitCode: null, timedOut: false, aborted: true, durationMs: Date.now() - started, stdoutTail: '', stderrTail: '', reason: '本轮被中止，验收命令已终止' });
        killGroup();
      };
      try { sig.addEventListener('abort', onAbort, { once: true }); } catch { /* 旧环境忽略 */ }
    }
  });
}
