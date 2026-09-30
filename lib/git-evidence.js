/**
 * 只读取证：让「文件类证据」由工具自己核实，而不是采信模型的说法。
 *
 * 两条来源纪律（借鉴 dsh-pua `review.js` 的 collectGitEvidence 做法）：
 *  1. **零宿主 API**：直接 `execFile('git', [...])`，不依赖 `ctx.subprocess` 之类的服务——
 *     宿主服务是最容易随版本变形的面，而 git 命令行十年不变。
 *  2. **失败必须如实说**：拿不到证据时返回 `{ ok: false, reason }`，由调用方原样呈现。
 *     绝不把「没取到」解释成「零文件 / 没跟踪」——那会把证据缺口伪装成清白。
 *
 * 另外：清空 `GIT_*` 环境变量（避免继承的仓库指向把只读查询重定向到别的仓库）、
 * 10s 超时、1MB 输出上限、`shell: false`（参数数组直传，不经 shell 解释）。
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

/** 会被只读查询继承、从而把结果指向别处仓库的 Git 环境变量。 */
const REPOSITORY_ENV_KEYS = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE', 'GIT_INDEX_FILE', 'GIT_NO_REPLACE_OBJECTS', 'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM', 'GIT_OBJECT_DIRECTORY',
];

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 1024 * 1024;

/** 允许继承给 git 的环境变量（白名单）。 */
const SAFE_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR', 'TZ', 'TERM', 'SHELL', 'SystemRoot', 'ComSpec', 'PATHEXT'];

/**
 * 干净环境：**白名单**构造，而不是删黑名单。
 *
 * 原因：黑名单一定会有漏项，而漏掉的键能静默改掉只读查询的结果——实测
 * `GIT_LITERAL_PATHSPECS=1` 会让 glob 路径被当字面量（`tracked.count` 变成 0），
 * `GIT_CONFIG_GLOBAL` 指向一份 `status.showUntrackedFiles=no` 的配置会让未跟踪文件
 * 整体消失而 `ok` 仍是 true。两者都直接违反「绝不把没取到解释成零文件」。
 */
export function gitEnv(base = process.env) {
  const env = {};
  for (const k of SAFE_ENV_KEYS) if (base?.[k] !== undefined) env[k] = base[k];
  for (const k of Object.keys(base ?? {})) if (/^LC_/.test(k)) env[k] = base[k];
  // 双保险：黑名单里的键一律不带过去（白名单已覆盖，留作显式意图）。
  for (const k of REPOSITORY_ENV_KEYS) delete env[k];
  // 显式切断用户/系统级 git 配置与属性文件，并禁止交互与分页。
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_SYSTEM = '/dev/null';
  env.GIT_ATTR_NOSYSTEM = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_PAGER = 'cat';
  return env;
}

/** 跑一条只读 git 命令；失败一律抛错，由调用方转成「如实降级」。 */
export function git(args, opts = {}) {
  const { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES } = opts;
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', ...args],
      { cwd, timeout: timeoutMs, maxBuffer: maxBytes, shell: false, env: gitEnv(), windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || err.message || '').split('\n')[0].slice(0, 200);
          const why = err.killed || err.signal ? `超时/被杀（${err.signal ?? 'timeout'}）` : '';
          reject(new Error(`git ${args[0]} 失败${why ? `（${why}）` : ''}：${detail}`));
          return;
        }
        resolvePromise(String(stdout));
      },
    );
  });
}

/** 解析 `-z` 输出（NUL 分隔）为数组；输出不以 NUL 结尾视为被截断。 */
function splitZ(text) {
  if (text === '') return [];
  if (!text.endsWith('\0')) throw new Error('git 输出不完整（可能被截断）');
  return text.slice(0, -1).split('\0');
}

const summarize = (paths) => ({
  count: paths.length,
  sample: paths.slice(0, 20),
  sampleComplete: paths.length <= 20,
});

/**
 * 采集只读 Git 证据。
 *
 * @param opts.cwd - 会话工作目录（必填；不是仓库时返回 ok:false 而不是空结果）。
 * @param opts.paths - 只关心这些路径（可选）；给空数组表示整个仓库。
 * @returns `{ ok: true, root, tracked, changed, commands }` 或 `{ ok: false, reason, commands }`
 */
export async function collectGitEvidence(opts = {}) {
  const cwd = opts.cwd;
  const paths = Array.isArray(opts.paths) ? opts.paths.filter((p) => typeof p === 'string' && p !== '') : [];
  const commands = [];
  if (typeof cwd !== 'string' || cwd === '' || !existsSync(cwd)) {
    return { ok: false, reason: '没有可用的会话工作目录，未获取 Git 证据（不得解释为「没有改动」）', commands };
  }
  const spec = paths.length > 0 ? ['--', ...paths] : [];
  try {
    commands.push('git rev-parse --show-toplevel');
    const root = (await git(['rev-parse', '--show-toplevel'], { cwd, ...opts })).trim();
    if (root === '') throw new Error('git 未返回工作树根目录');

    const trackedArgv = ['ls-files', '--full-name', '--cached', '--deduplicate', '-z', ...spec];
    commands.push(['git', ...trackedArgv].join(' '));
    const tracked = splitZ(await git(trackedArgv, { cwd, ...opts }));

    const statusArgv = ['status', '--porcelain=v1', '-z', ...spec];
    commands.push(['git', ...statusArgv].join(' '));
    const statusZ = await git(statusArgv, { cwd, ...opts });
    const changed = [];
    const parts = statusZ === '' ? [] : statusZ.split('\0').filter((s) => s !== '');
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (part.length < 4) throw new Error('git status 输出字段不完整（可能被截断）');
      // porcelain v1 -z：`XY <path>`；R/C 状态下**紧跟的下一段是原路径**，必须整段跳过，
      // 否则原路径会被当成一条新记录解析出「a. s」这种幻影条目，而真实的重命名反而丢失。
      const code = part.slice(0, 2);
      const file = part.slice(3);
      if (code[0] === 'R' || code[0] === 'C') {
        i += 1;
        const origin = parts[i] ?? '';
        if (file !== '') changed.push(`${code.trim()} ${file} ← ${origin}`);
        continue;
      }
      if (file !== '') changed.push(`${code.trim() || '??'} ${file}`);
    }
    return {
      ok: true,
      root,
      tracked: summarize(tracked),
      changed: summarize(changed),
      commands,
    };
  } catch (err) {
    return { ok: false, reason: String(err?.message ?? err).slice(0, 240), commands };
  }
}

/** 把 `path` / `path:line` / `path:line-line` 形式的引用拆开。 */
export function parseFileRef(ref) {
  const raw = String(ref ?? '').trim();
  if (raw === '') return { path: '', line: null };
  const cut = raw.lastIndexOf(':');
  if (cut > 0) {
    const tail = raw.slice(cut + 1);
    const first = tail.split('-')[0];
    if (/^\d+$/.test(first)) {
      return { path: raw.slice(0, cut), line: Number(first) };
    }
  }
  return { path: raw, line: null };
}

/**
 * 文件类证据取证：该路径是否存在、是否已被 git 索引收录。
 *
 * 只回答这两个可以用只读查询判定的事实；更远的结论（提交状态、远端同步）
 * 不在取证范围——宁可少说，也不猜。
 */
export async function fileEvidenceFacts({ cwd, ref, timeoutMs, maxBytes } = {}) {
  const { path: refPath, line } = parseFileRef(ref);
  if (refPath === '') return { ok: false, reason: '文件类证据必须带路径（如 `lib/index.js:42`）' };
  // 没有会话工作目录就不能取证：否则会落到**插件进程自己的 cwd**，给错误坐标打上「客观事实」。
  if (typeof cwd !== 'string' || cwd === '') {
    return { ok: false, reason: '没有会话工作目录，未取证（不得据此认为文件不存在）' };
  }
  const abs = isAbsolute(refPath) ? refPath : resolve(cwd, refPath);
  const exists = existsSync(abs);
  const facts = { ok: true, path: refPath, line, exists };
  try {
    facts.bytes = exists && statSync(abs).isFile() ? statSync(abs).size : null;
  } catch {
    facts.bytes = null;
  }
  // 行号要验：引用一个不存在的行，正是这套插件最该抓的假事实。
  if (exists && line !== null) {
    try {
      const text = readFileSync(abs, 'utf8');
      const total = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      facts.totalLines = total;
      facts.lineInRange = line <= total;
    } catch {
      facts.lineInRange = null;
    }
  }
  try {
    await git(['ls-files', '--error-unmatch', '--', refPath], { cwd, timeoutMs, maxBytes });
    facts.tracked = true;
  } catch (err) {
    const msg = String(err?.message ?? '');
    // 区分「确实没被跟踪」与「根本没法问 git」：后者不能当成 false。
    facts.tracked = /did not match any file|error-unmatch/i.test(msg) ? false : null;
    if (facts.tracked === null) facts.gitError = msg.slice(0, 160);
  }
  if (!exists) {
    facts.ok = false;
    facts.reason = `文件不存在：${refPath}（引用不存在的东西不能算证据）`;
  }
  return facts;
}
