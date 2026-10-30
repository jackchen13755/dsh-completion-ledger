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
 *  - `detached: true` + 杀进程组：超时只杀 shell 会把子进程留成孤儿。
 *
 * 已知边界（如实写在代码里，不要以为它是安全边界）：
 *  - 它执行的是**当前工作区的代码**（`pnpm test` 读 package.json）。模型若能改 `package.json`
 *    里的脚本，就等于能改它执行的代码。因此「命令只能引用用户声明的 id」只挡住了命令自拟，
 *    挡不住「用户声明的命令所执行的脚本被改」——后者要靠 `verify.enabled` 的启用决策来权衡。
 */
import { execFile } from 'node:child_process';

/** 允许透传给验收命令的环境变量（白名单，不是黑名单）。 */
const ENV_ALLOW = [
  // HOME 必须给：`git config --global`、多数测试框架的缓存都依赖它，缺了会给出假失败。
  // 代价是验收命令能读到 ~/.ssh、~/.aws —— 这也是「命令必须是用户自己声明」的现实理由之一。
  'HOME', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP',
  'SHELL', 'USER', 'LOGNAME', 'TERM', 'TZ',
  'SystemRoot', 'ComSpec', 'PATHEXT', 'SystemDrive', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
];

/**
 * 构造验收命令的环境变量。
 *
 * `PWD` 由调用方按**真实 cwd** 覆盖：继承来的 `PWD` 是插件进程的目录，
 * 脚本若按 `$PWD` 定位会跑错目录。
 */
export function oracleEnv(cwd = '', base = process.env) {
  const env = {};
  for (const k of ENV_ALLOW) if (base?.[k] !== undefined) env[k] = base[k];
  if (typeof cwd === 'string' && cwd !== '') env.PWD = cwd;
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
 * @returns {Promise<{ok:boolean, exitCode:number|null, timedOut:boolean, aborted:boolean,
 *   signal:string|null, durationMs:number, stdoutTail:string, stderrTail:string, reason:string}>}
 */
export function runOracle(command, opts = {}) {
  const cwd = opts.cwd;
  const timeoutMs = Math.max(100, Number(opts.timeoutMs) || 120000);
  const tailChars = Math.max(200, Number(opts.tailChars) || 2000);
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
      resolve({ aborted: false, signal: null, ...v });
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
        env: oracleEnv(cwd),
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
