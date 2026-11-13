/**
 * 「这次动作算不算写文件」的**唯一**判据来源。
 *
 * 为什么要抽出来（2026-11-11 第 1 轮评审 P1-2 / P1-3）：
 *  - P1-3：原先 `lib/two-phase-gate.js` 自己写了一份 `MUTATION_TOOLS = ['edit','write']`，
 *    于是 `run_code`（本宿主一等工具）/ `apply_patch` / `multi_edit` 写满全仓都不触发闸门。
 *    「另写一份名单」必然漂移，所以两份判据必须来自**同一个模块**。
 *  - P1-2：原先写特征表只有 `sed -i` / `git apply` / `prettier --write` 与一条
 *    `\s>\s*[^\s|&]+`，把 `> /dev/null`、`git apply --check`、`awk "$1 > 3"` 全判成写文件，
 *    又把 `2> file`、`echo hi>out.txt`、`| tee`、`biome --write` 全漏掉。
 *
 * 判定顺序（先归一化再判定，次序不能换）：
 *  1. `stripRedirectNoise`：剔 `/dev/null`、`2>&1`、`>&2` 这些无害重定向；
 *  2. `stripArrows`：抹掉 `=>`，否则箭头函数里的 `>` 被当重定向（`lib/index.js` 原注释踩过）；
 *  3. 写动词（tee / cp / mv / rm / touch / truncate / sed -i / biome|prettier --write）；
 *  4. `git apply` 区分 `--check`（只检查不落地）；
 *  5. 重定向必须**有真实文件目标**：`/dev/null|/dev/std*|/dev/fd/N` 与纯数字（比较运算）不算；
 *  6. 引号内的 `>` 不是外层重定向，除非外面套了 `bash -c` / `sh -c`；
 *  7. `run_code` 这类没有 shell 动词的文件写入 API（`fs.writeFileSync`）。
 *
 * **纯函数、无副作用**：`lib/index.js` 的写入门禁与 `lib/two-phase-gate.js` 的派生闸门共用。
 */

/** 全部「可能改文件」的工具名（文件类 + shell 类）。 */
export const WRITE_TOOLS = /^(write|edit|str_replace|multi_edit|apply_patch|bash|pwsh|run_code|terminal)$/i;
/** 文件类写工具：入参里直接带目标路径，算写动作不需要看正文。 */
export const FILE_WRITE_TOOLS = /^(write|edit|str_replace|multi_edit|apply_patch)$/i;
/** shell 类工具：目标写在命令正文里，必须走文本判定。 */
export const SHELL_TOOLS = /^(bash|pwsh|run_code|terminal)$/i;
/** shell 里的写动词（重定向单独判，见 `redirectTargetsOf`）。 */
export const MUTATE_SHELL =
  /(\btee\b|\bcp\b|\bmv\b|\brm\b|\btruncate\b|\btouch\b|\binstall\b|sed\s+-i|(?:prettier|biome)\s+[^|;&]*--write)/i;
/** `run_code` 里的文件写入 API：`node -e "fs.writeFileSync(账本)"` 不含任何 shell 动词。 */
export const FS_WRITE_API =
  /\b(writeFileSync|writeFile|appendFileSync|appendFile|rmSync|unlinkSync|renameSync|copyFileSync|mkdirSync|truncateSync|createWriteStream)\b/;

/** `git apply` 与它的「只看不落地」开关。 */
const GIT_APPLY_RE = /\bgit\s+apply\b/i;
const GIT_APPLY_DRY_RE = /(?:^|\s)--(?:check|stat|numstat|summary)\b/i;

/** python heredoc 里改写文件：必须同时命中 heredoc 与 open(...,'w')。 */
export const PY_HEREDOC_RE = /python3?\s+-\s*<</;
export const PY_WRITE_OPEN_RE = /open\([^)]*,\s*['"]w/;

/** 引号内含重定向时，只有外层还套了 `bash -c` 才算真实写。 */
const INNER_SHELL_RE = /\b(?:bash|sh|zsh|ksh)\s+-c\b/i;
const QUOTED_RE = /'[^']*'|"[^"]*"/g;
/** 重定向：`>` / `>>` / `>|`；目标不能是 `&`（fd 复制）或 `|`。 */
const REDIRECT_RE = />>?\|?\s*([^\s|&;<>()]+)/g;
/** 无害输出端：写它们不改变任何文件。 */
const DEV_SINK_RE = /^\/dev\/(?:null|zero|std(?:out|err|in)|fd\/\d+)$/;
/** 纯数字目标（`awk "$1 > 3"`、`node -e "1 > 0"`）是比较运算，不是文件名。 */
const NUMERIC_TARGET_RE = /^\d+$/;

/** 无害重定向（`/dev/null`、`2>&1`、`>&2`）不是「改文件」，必须剔除。 */
export const stripRedirectNoise = (t) => String(t)
  .replace(/[012]?>>?\s*\/dev\/(?:null|stdout|stderr)\b/g, ' ')
  .replace(/&>>?\s*[12]\b/g, ' ')
  .replace(/[012]?>&[012]\b/g, ' ');

/** 抹掉箭头函数：`=>` 里的 `>` 不是重定向。 */
export const stripArrows = (t) => String(t).replace(/=>/g, ' ');

/**
 * 文本里出现的重定向是否有**真实文件目标**（已归一化后的文本）。
 *
 * @param {string} text
 * @param {{ quotedRedirects?: boolean }} [opts]
 *   `quotedRedirects: true` = 引号内的重定向也算（**保守**，给写入门禁用）：
 *   `perl -e 'open(F,">","<账本>")'`、`awk 'BEGIN{print "{}" > "<账本>"}'` 这类
 *   「解释器自带重定向」的 `>` 落在引号里，默认按「引号内多半是比较运算」跳过——
 *   那把这条判定复用给写入门禁就会**削弱**门禁（2026-11-11 第 2 轮评审实测）。
 *   门禁侧路径已被 `mentionsPath` 精确锁定，多判无害，所以它传 true。
 */
export function redirectTargetsOf(text, opts = {}) {
  const s = String(text ?? '');
  const quoted = [];
  for (const m of s.matchAll(QUOTED_RE)) quoted.push([m.index, m.index + m[0].length]);
  const insideQuotes = (i) => quoted.some(([a, b]) => i >= a && i < b);
  const innerShell = INNER_SHELL_RE.test(s);
  const out = [];
  for (const m of s.matchAll(REDIRECT_RE)) {
    const at = m.index + m[0].indexOf('>');
    if (opts.quotedRedirects !== true && !innerShell && insideQuotes(at)) continue;
    const target = m[1].replace(/["'`]+$/, '');
    if (target === '' || DEV_SINK_RE.test(target) || NUMERIC_TARGET_RE.test(target)) continue;
    out.push(target);
  }
  return out;
}

/**
 * 一段 shell / run_code 正文是不是「写文件」。
 *
 * @param {string} rawText 工具参数正文（`command` / `code` / 压平的 JSON 均可）
 * @param {{ quotedRedirects?: boolean }} [opts] 见 `redirectTargetsOf`
 * @returns {boolean}
 */
export function shellMutationOf(rawText, opts = {}) {
  const text = stripArrows(stripRedirectNoise(rawText));
  if (text === '') return false;
  if (MUTATE_SHELL.test(text)) return true;
  if (GIT_APPLY_RE.test(text) && !GIT_APPLY_DRY_RE.test(text)) return true;
  if (PY_HEREDOC_RE.test(text) && PY_WRITE_OPEN_RE.test(text)) return true;
  if (redirectTargetsOf(text, opts).length > 0) return true;
  return FS_WRITE_API.test(text);
}
