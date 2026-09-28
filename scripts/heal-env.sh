#!/bin/bash
# 环境自愈：① 三个 peer 链回宿主同实例 ② linter 可执行换成不依赖 PATH 的原生二进制。
#
# 为什么需要：
#  - npm install 会把 node_modules 里「不在依赖树里」的目录当 extraneous 清掉，而本仓库的
#    三个 peer 是**手工软链到宿主同实例**的（必须是宿主那一份：schemastery 的 schema 会被
#    宿主按实例校验，装副本会踩坑）。实测 2026-09-28：一次 `npm i -D @biomejs/biome`
#    就把三条链全剪了，插件随后 `[no-fiber]`。
#  - Biome 官方在 node_modules/.bin 放的是 `#!/usr/bin/env node` 垫片，而 DSH 桌面端由
#    Finder 启动，PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin —— dsh-lint-loop spawn 它时
#    报 `env: node: No such file or directory`（exit 127）。改用 @biomejs/cli-* 里的
#    **原生二进制**（实测 `env -i …/biome --version` 可用），彻底不依赖 PATH。
# 两件事都挂在 package.json 的 postinstall 上，装完自动愈合。
#
# 挑哪一份宿主副本（本机有多个 npx 残留，实测挑错过一次：挑到只有 0.1.6 schemastery 的旧目录）：
#   ① DSH_HOST_NODE_MODULES 显式指定 > ② 含 @deepseek-ai/dsh 的**完整安装**（按 mtime 新的优先）
#   > ③ 其余含 peer 的 node_modules（profile 等，通常只有 schemastery）
#   最后拿 profile 里的 schemastery 版本跟选中的那份交叉核对，不一致就告警。
#
# 用法：
#   bash scripts/heal-env.sh                                       # 自动探测
#   DSH_HOST_NODE_MODULES=<宿主>/node_modules bash scripts/heal-env.sh
#   DSH_LINK_PEERS_STRICT=1 bash scripts/heal-env.sh               # 有问题就退出码 1
#
# 退出码：0 = 两条都自愈好（含本来就好）；strict 模式下有问题才 1。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

PEERS=("@deepseek-ai/dsh-tools" "@deepseek-ai/dsh-llm" "@deepseek-ai/schemastery")
STRICT="${DSH_LINK_PEERS_STRICT:-0}"
ver_of() { node -e "try{console.log(require('$1/package.json').version)}catch(e){console.log('?')}" 2>/dev/null || echo '?'; }

# —— 候选宿主 node_modules（按优先级排序）——
CANDS=()
[ -n "${DSH_HOST_NODE_MODULES:-}" ] && CANDS+=("$DSH_HOST_NODE_MODULES")

full=(); other=()
for pattern in "$HOME"/.npm/_npx/*/node_modules "$HOME"/.dsh/dsh-runtimes/*/node_modules "$HOME"/.dsh/profiles/*/node_modules; do
  for d in $pattern; do
    [ -d "$d" ] || continue
    if [ -f "$d/@deepseek-ai/dsh/package.json" ]; then
      full+=("$(stat -f '%m' "$d/@deepseek-ai/dsh/package.json" 2>/dev/null || echo 0)|$d")
    else
      other+=("$d")
    fi
  done
done
# 完整安装按 mtime 从新到旧
while IFS='|' read -r _ts dir; do [ -n "${dir:-}" ] && CANDS+=("$dir"); done < <(printf '%s\n' "${full[@]:-}" | sort -rn)
CANDS+=("${other[@]:-}")

if [ "${#CANDS[@]}" -eq 0 ] || [ -z "${CANDS[0]:-}" ]; then
  echo "link-peers: 找不到任何候选宿主 node_modules（可用 DSH_HOST_NODE_MODULES 显式指定）" >&2
  [ "$STRICT" = "1" ] && exit 1
  exit 0
fi

missing=0
chosen_schemastery=""
for pkg in "${PEERS[@]}"; do
  target=""
  for c in "${CANDS[@]}"; do
    [ -n "$c" ] && [ -f "$c/$pkg/package.json" ] && { target="$c/$pkg"; break; }
  done
  link="node_modules/$pkg"
  if [ -z "$target" ]; then
    echo "  ✗ $pkg：宿主副本没找到（候选 ${#CANDS[@]} 个）"
    missing=1
    continue
  fi
  [ "$pkg" = "@deepseek-ai/schemastery" ] && chosen_schemastery="$(ver_of "$target")"

  if [ -L "$link" ] && [ "$(readlink "$link")" = "$target" ]; then
    echo "  ✓ $pkg@$(ver_of "$target")（已是宿主副本）"
    continue
  fi
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    echo "  ! $link 已存在且不是软链——未动它（请人工确认）"
    missing=1
    continue
  fi
  mkdir -p "$(dirname "$link")"
  [ -L "$link" ] && rm -f "$link"     # 只删软链本身；不用 rm -rf，避免踩删除门禁
  ln -s "$target" "$link"
  echo "  ✓ $pkg@$(ver_of "$target") → $target"
done

# —— 交叉核对：profile 里那份 schemastery 就是宿主自己的一份 ——
for p in "$HOME"/.dsh/profiles/*/node_modules/@deepseek-ai/schemastery; do
  [ -f "$p/package.json" ] || continue
  profile_ver="$(ver_of "$p")"
  if [ -n "$chosen_schemastery" ] && [ "$chosen_schemastery" != "$profile_ver" ]; then
    echo "  ! 版本交叉核对不一致：链上的 schemastery@$chosen_schemastery ≠ profile 里的 @$profile_ver" >&2
    echo "    （说明可能挑到了别的 npx 残留；可用 DSH_HOST_NODE_MODULES 显式指定宿主那一份）" >&2
    missing=1
  else
    echo "  · 版本交叉核对通过（schemastery@$profile_ver 与 profile 一致）"
  fi
  break
done

# —— ② linter 可执行：把 .bin/biome 换成原生二进制（不依赖 PATH 里的 node）——
echo "=== linter 可执行 ==="
native=""
for c in node_modules/@biomejs/cli-*/biome node_modules/@biomejs/cli-*/biome.exe; do
  for f in $c; do [ -x "$f" ] && { native="$f"; break; }; done
  [ -n "$native" ] && break
done
bin_link="node_modules/.bin/biome"
if [ -z "$native" ]; then
  echo "  ! 没找到 @biomejs/cli-*/biome 原生二进制——先 npm i -D @biomejs/biome" >&2
  missing=1
elif [ -L "$bin_link" ] && [ "$(readlink "$bin_link")" = "$(cd "$(dirname "$native")" && pwd)/$(basename "$native")" ]; then
  echo "  ✓ $bin_link → 原生二进制（已是）"
else
  mkdir -p node_modules/.bin
  [ -L "$bin_link" ] && rm -f "$bin_link"
  if [ -e "$bin_link" ]; then
    echo "  ! $bin_link 已存在且不是软链——未动它（请人工确认）" >&2
    missing=1
  else
    ln -s "$(cd "$(dirname "$native")" && pwd)/$(basename "$native")" "$bin_link"
    echo "  ✓ $bin_link → $native（绕开 PATH 里的 node）"
  fi
fi

if [ "$missing" = "1" ]; then
  echo "heal-env: 有 peer 未链上/存疑——插件在宿主里会因 ESM 静态导入失败变成 [no-fiber]" >&2
  [ "$STRICT" = "1" ] && exit 1
fi
exit 0
