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
import { existsSync, statSync } from 'node:fs';
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

/** 干净环境：保留 PATH/HOME/LANG，去掉一切 GIT_*，并禁止交互式提问与分页。 */
export function gitEnv(base = process.env) {
  const env = { ...base };
  for (const k of REPOSITORY_ENV_KEYS) delete env[k];
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
          reject(new Error(`git ${args[0]} 失败：${detail}`));
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

    commands.push('git ls-files --cached --deduplicate -z');
    const tracked = splitZ(await git(['ls-files', '--full-name', '--cached', '--deduplicate', '-z', ...spec], { cwd, ...opts }));

    commands.push('git status --porcelain=v1 -z');
    const statusZ = await git(['status', '--porcelain=v1', '-z', ...spec], { cwd, ...opts });
    const changed = [];
    const parts = statusZ === '' ? [] : statusZ.split('\0').filter((s) => s !== '');
    for (const part of parts) {
      // porcelain v1 -z：`XY <path>`；重命名/复制会有第二段（原路径），跳过。
      const code = part.slice(0, 2);
      const file = part.slice(3);
      if (code === 'R ' || code === 'RM' || code.startsWith('R')) continue;
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
    if (first !== '' && String(Number(first)) === first && Number(first) >= 0) {
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
  const abs = isAbsolute(refPath) ? refPath : resolve(String(cwd ?? '.'), refPath);
  const exists = existsSync(abs);
  const facts = { ok: true, path: refPath, line, exists };
  try {
    facts.bytes = exists && statSync(abs).isFile() ? statSync(abs).size : null;
  } catch {
    facts.bytes = null;
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
