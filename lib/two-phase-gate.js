/**
 * 两段式闸门（阶段① 方案 / 阶段② 实现）——判定本体。
 *
 * 要堵的口子：叫过专家拿方案，然后主会话自己把实现写完，`ledger_check` 仍返回 complete。
 * 判据**不取自模型自己登记的清单**，而取自已观察动作（`activity`）：本轮有没有写文件。
 *
 * 为什么单独成模块：按仓库根 AGENTS.md「判定类代码」硬要求，判定逻辑不许内联在调用方里，
 * 必须是可 require 的独立模块，外部才能直接喂边界输入验证。
 *
 * **纯函数**：不读文件、不读时间、不读会话，只吃入参。
 */
import {
  FILE_WRITE_TOOLS,
  FS_WRITE_API,
  SHELL_TOOLS,
  shellMutationOf,
  stripArrows,
  stripRedirectNoise,
} from './write-signals.js';

/** 阶段② 声明条目的识别。 */
const PHASE2_TEXT_RE = /阶段\s*②|阶段2|实现者|implementer/i;
/**
 * 专家侧主语：本机 Agency 专家的**中文职称**里既没有「专家」二字、也没有英文 engineer/architect
 * （`软件架构师` / `前端开发者` / `工程效率工程师` / `高级开发者`），只认英文词会漏判。
 * 英文词一律带 `\b` 边界，否则 `analyze` 里的 `analyst` 之类会误中。
 */
const EXPERT_SUBJECT_RE =
  /专家|工程师|架构师|开发者|设计师|分析师|研究员|统计学家|测试师|\b(?:engineer|architect|developer|designer|analyst|researcher|scientist)\b/i;
/** 主会话侧主语：命中即「如实声明自己实现」，不算矛盾。 */
const MAIN_SUBJECT_RE = /主\s*agent|主会话|captain|我自己|由我|本人|我(?:完成|写完|实现|改|做)|\bAI\b|(?:^|[^a-z])ai(?![a-z])/i;
/** 豁免条目。 */
const WAIVER_RE = /豁免|waiver/i;
/** 只有一个路径 token 的 detail 才算「能判断文件数」：含空白 / 引号 / 花括号一律视为无法判断。 */
const SINGLE_PATH_RE = /^[^\s{}"'`,;:()<>]+$/;

const NONE = { required: false, mutations: 0, files: 0, pathsUnknown: false, missing: [], notes: [], waived: false };

/**
 * 一条活动算不算「本轮改了文件」。
 *
 * 只判「有没有写动作、写没写文件」——刻意**不**用任务类型、路径白名单去判 mutation，
 * 那些判据会随仓库结构漂移。写工具清单与写特征表都来自 `write-signals.js`（单一来源）。
 */
function isMutation(entry) {
  const name = String(entry?.name ?? '');
  if (FILE_WRITE_TOOLS.test(name)) return true;
  if (!SHELL_TOOLS.test(name)) return false;
  const s = String(entry?.detailFull ?? entry?.detail ?? '');
  if (s === '') return false;
  if (shellMutationOf(s)) return true;
  // 文件写入 API 也要在归一化后的文本上判（`node -e "x => fs.writeFile()"`）。
  return FS_WRITE_API.test(stripArrows(stripRedirectNoise(s)));
}

/**
 * 从 `edit` / `write` 的 detailFull 抽路径，供「涉及几个文件」判定使用。
 *
 * 只有在 detail 是**单个路径形态**时才抽：`detailOfArguments` 在入参缺
 * `command/cmd/path/file_path/query` 时会退到 `JSON.stringify` 分支，那时
 * `old_string` / `new_string` 正文里的路径会被当成文件名（实测单文件 edit 算出 4 个文件）。
 * 抽不到 → 返回空，由调用方按 spec §3.5「无法判断 → 不强制」处理。
 */
function pathsOf(entry) {
  const s = String(entry?.detailFull ?? entry?.detail ?? '').trim();
  if (s === '' || !SINGLE_PATH_RE.test(s)) return [];
  if (!/[./]/.test(s)) return [];
  return [s];
}

/**
 * 一条阶段② 声明说的是「谁实现的」。
 *
 * 判据是**实现者字段的主语**，不是全文子串：旧实现用全文匹配，于是
 * 「前端开发者完成（主会话只做验收）」里出现「主会话」四个字就免罪，
 * 而「由我完成（方案来自软件架构师）」反而因为出现「架构师」被判矛盾。
 */
function subjectPhraseOf(text) {
  const s = String(text ?? '');
  const field = /(?:实现者|实现方|实现|implementer)\s*[:：]\s*([^，。;（(\n]{0,16})/i.exec(s);
  if (field) return field[1].trim();
  const head = s.replace(/^\s*(?:阶段\s*②|阶段2)\s*[:：]?\s*/, '');
  return String(head.split(/[，。;（(\n]/)[0] ?? '').trim();
}

/**
 * 两段式派生闸门。
 *
 * @param {{ items?: object[], activity?: object[], config?: object }} input
 *   `items` 账本条目 `[{ id, text, kind, status, evidence: [{ kind, ref, note, verified }] }]`；
 *   `activity` 已观察动作 `[{ name, detailFull, at, ok }]`；
 *   `config` `{ twoPhaseGate?: boolean, twoPhaseForceEvidence?: boolean }`。
 * @returns {{ required: boolean, mutations: number, files: number, pathsUnknown: boolean, missing: object[], notes: object[], waived: boolean }}
 */
export function evaluateTwoPhase({ items, activity, config } = {}) {
  const cfg = config ?? {};
  const led = Array.isArray(items) ? items : [];
  const acts = Array.isArray(activity) ? activity : [];

  // 逃生开关：false 时闸门完全不介入。
  if (cfg.twoPhaseGate === false) return { ...NONE };
  const mutations = acts.filter(isMutation);
  // 没观察到写动作（纯评审、只给结论的回合）→ 不误伤。
  if (mutations.length === 0) return { ...NONE };

  const n = mutations.length;
  const files = new Set();
  let pathsUnknown = false;
  for (const a of mutations) {
    if (!FILE_WRITE_TOOLS.test(String(a?.name ?? ''))) continue;
    const ps = pathsOf(a);
    if (ps.length === 0) pathsUnknown = true;
    else for (const p of ps) files.add(p);
  }

  const missing = [];
  const notes = [];
  const phase2 = led.find((it) => PHASE2_TEXT_RE.test(String(it?.text ?? '')));

  if (phase2 === undefined) {
    missing.push({
      id: 'PHASE2',
      text: '阶段② 实现交代',
      reason: `本轮观察到 ${n} 次文件写入，但账本没有登记「阶段② 实现由谁做 / 改了哪些文件」`,
    });
  } else if (!((phase2.evidence?.length ?? 0) > 0)) {
    missing.push({ id: 'PHASE2', text: '阶段② 实现交代', reason: '阶段② 条目没有任何证据' });
  } else {
    // 3.4 矛盾检测：不能证明「专家写了」，但能证明「主会话写了」——判「声明与观察是否矛盾」。
    // 只看实现者**主语**：声明主语是主会话 → 与观察一致，不判矛盾；
    // 主语是专家 → 矛盾（本轮写入只可能来自主会话）。方案出处的提及不参与判定。
    const subject = subjectPhraseOf(phase2.text);
    if (EXPERT_SUBJECT_RE.test(subject) && !MAIN_SUBJECT_RE.test(subject)) {
      missing.push({
        id: 'PHASE2-CONTRADICTION',
        text: '阶段② 实现交代',
        reason: `声明「${subject}」实现，但本轮观察到 ${n} 次文件写入来自主会话——账本侧无法证明专家做过实现，请改成如实声明`,
      });
    }
    // 3.5 客观证据要求：只在「显式要求」或「涉及 ≥2 个文件」时提；单文件/纯文档不强制。
    // 文件数无法判断（detail 是压平的 JSON 之类）→ 按 spec §3.5 不强制，避免误伤。
    const needObjective = cfg.twoPhaseForceEvidence === true
      || (!pathsUnknown && files.size >= 2);
    const hasObjective = (phase2.evidence ?? []).some((e) => String(e?.kind ?? 'manual') !== 'manual');
    if (needObjective && !hasObjective) {
      const why = files.size >= 2 ? `本轮改动涉及 ${files.size} 个文件` : '已要求客观证据';
      missing.push({
        id: 'PHASE2-EVIDENCE',
        text: '阶段② 实现交代',
        reason: `阶段② 只有自述证据；${why}，需要至少一条非 manual 证据（file / ledger_verify）`,
      });
    }
  }

  // 3.6 豁免：**只**降级 PHASE2-EVIDENCE。
  // - PHASE2（完全没有阶段② 声明）不可豁免：那是 spec §1 最严重的一格，一句自述不能放行；
  // - PHASE2-CONTRADICTION 不可豁免：声明与观察矛盾是客观事实；
  // - 豁免自身的证据必须 kind !== 'manual'：自述不能自己给自己发豁免（正是 §1 堵的最弱证据）。
  const waived = led.some((it) => WAIVER_RE.test(String(it?.text ?? ''))
    && (it.evidence ?? []).some((e) => String(e?.kind ?? 'manual') !== 'manual'));
  if (waived) {
    for (let i = missing.length - 1; i >= 0; i -= 1) {
      if (missing[i].id === 'PHASE2-EVIDENCE') notes.unshift(missing.splice(i, 1)[0]);
    }
  }

  return { required: true, mutations: n, files: files.size, pathsUnknown, missing, notes, waived };
}
