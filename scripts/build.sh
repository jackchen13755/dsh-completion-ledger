#!/bin/bash
# dsh-completion-ledger 交付前自检。
#
# 本插件是**纯 ESM、无编译步骤**：源码就是 lib/index.js，宿主直接加载。
# 原因：本机只有 Electron/asar 打包的 DSH 与 npx 安装副本，没有带 packages/ 的
# DSH 源码 checkout，脚手架默认的 tsc 链路（依赖 DSH_CHECKOUT）不可用；
# 而宿主只要求 entry 导出 { name, apply }，无需编译产物。
#
# 所以 build 的含义是「自检」：① 能装载 ② peer 链接就位 ③ 账本目录可写。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

NODE="${NODE:-}"
if [ -z "$NODE" ]; then
  for c in /usr/local/bin/node "$(command -v node 2>/dev/null || true)"; do
    [ -n "$c" ] && [ -x "$c" ] && { NODE="$c"; break; }
  done
fi
[ -n "$NODE" ] || { echo "check: 找不到 node（可用 NODE=/path/to/node 指定）" >&2; exit 1; }

echo "=== 1) 自检：装载 + 回注消息契约 + 账本纯函数（scripts/smoke.mjs）==="
"$NODE" "$ROOT/scripts/smoke.mjs"

echo "=== 2) peer 链接（npm install 会把它们当 extraneous 剪掉，用 scripts/heal-env.sh 自愈）==="
missing=0
for p in "@deepseek-ai/dsh-tools" "@deepseek-ai/dsh-llm" "@deepseek-ai/schemastery"; do
  if [ -e "node_modules/$p/package.json" ]; then
    ver=$("$NODE" -e "console.log(require('$ROOT/node_modules/$p/package.json').version)")
    echo "  ✓ $p@$ver"
  else
    echo "  ✗ 缺 $p —— 跑 bash scripts/link-peers.sh 链回宿主同实例"; missing=1
  fi
done
[ "$missing" = "0" ] || exit 1

echo "=== 3) 账本目录可写 ==="
LEDGER_DIR="${DSH_HOME:-$HOME/.dsh}/completion-ledger"
mkdir -p "$LEDGER_DIR" && echo "  ✓ $LEDGER_DIR"

echo "=== 自检通过 ==="
