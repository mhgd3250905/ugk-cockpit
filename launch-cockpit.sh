#!/bin/sh
# macOS 启动器：对应 Windows 的 launch-cockpit.cmd / scripts/launch-cockpit.ps1。
# Windows 之外没有 LOCALAPPDATA，因此通过 --data-directory 指定数据目录。
set -eu

REPO_ROOT=$(cd "$(dirname "$0")" && pwd)
# 测试与多实例场景可用 UGK_COCKPIT_PORT 覆盖；正式入口固定默认端口。
PORT="${UGK_COCKPIT_PORT:-41737}"
BASE_URL="http://127.0.0.1:${PORT}"

# 数据目录优先级：显式 UGK_COCKPIT_DATA（隔离验证、多实例）> 已保存目录 >
# macOS 标准位置（与 scripts/plugin-output-root.mjs 的 darwin 分支一致）。
# 显式目录必须压过保存记录，否则隔离测试可能启动、迁移真实数据库。
DATA_DIRECTORY="${UGK_COCKPIT_DATA:-}"
SAVED_FILE="$REPO_ROOT/.data/service-directory.txt"
if [ -z "$DATA_DIRECTORY" ] && [ -f "$SAVED_FILE" ]; then
    SAVED_DIR=$(tr -d '\n\r' < "$SAVED_FILE")
    case "$SAVED_DIR" in
        /*) DATA_DIRECTORY="$SAVED_DIR" ;;
    esac
fi
if [ -z "$DATA_DIRECTORY" ]; then
    DATA_DIRECTORY="$HOME/Library/Application Support/UGK Cockpit"
fi

# 项目要求 Node.js >=24.15.0 <25（package.json engines）。默认 node 不满足时
# 依次尝试本机安装的 Node 24：Homebrew keg-only node@24、~/.local/node。
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" != "24" ]; then
    for candidate in /opt/homebrew/opt/node@24/bin "$HOME/.local/node/bin"; do
        if [ -x "$candidate/node" ] && [ "$("$candidate/node" -p 'process.versions.node.split(".")[0]')" = "24" ]; then
            export PATH="$candidate:$PATH"
            break
        fi
    done
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
NODE_MINOR=$(node -p 'process.versions.node.split(".")[1]' 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" != "24" ] || [ "$NODE_MINOR" -lt 15 ]; then
    echo "[ERROR] 需要 Node.js >=24.15.0 <25，当前为 $(node --version 2>/dev/null || echo 未安装)。"
    echo "可执行: export PATH=\"/opt/homebrew/opt/node@24/bin:\$PATH\" 后重试。"
    exit 1
fi

# 前端资源缺失时构建一次（与 setup 脚本的 webReady 判断一致）；
# UGK_COCKPIT_SKIP_BUILD=1 供隔离验证跳过构建。
if [ ! -f "$REPO_ROOT/dist/web/index.html" ] && [ "${UGK_COCKPIT_SKIP_BUILD:-}" != "1" ]; then
    echo "[BUILD] npm run build:web ..."
    (cd "$REPO_ROOT" && npm run build:web)
fi

mkdir -p "$DATA_DIRECTORY/logs"

# 项目数据核对（与安装器同一事实源）：磁盘记录、服务项目列表及全部详情一致
# 才允许报告成功。失败只报告并引导恢复，绝不替换服务、清库或重新添加项目。
# 函数定义必须在下方复用判断之前：/bin/sh 顺序执行，调用点不能先于定义。
verify_data() {
    echo "[VERIFY] 核对数据目录（$DATA_DIRECTORY）与服务的项目记录 ..."
    if ! node "$REPO_ROOT/scripts/verify-service-data.mjs" "$DATA_DIRECTORY" "$BASE_URL"; then
        echo "[ERROR] 服务数据核对失败：运行中的服务与数据目录的项目记录不一致，或所选数据目录无法读取。"
        echo "本脚本不会替换服务、清理数据库或重新添加项目；请按 docs/LOCAL_SERVICE_RECOVERY.md 排查。"
        return 1
    fi
}

# 端口已被健康且版本一致的 Cockpit 占用时直接复用，不替换运行中的服务。
# 与安装器 probe 同强度：health 必须是 status=ok 且版本与当前程序一致，
# 否则按本机服务恢复流程处理，绝不自动重启或覆盖。
HEALTH=$(curl -fsS --max-time 3 "$BASE_URL/health" 2>/dev/null || true)
if [ -n "$HEALTH" ]; then
    EXPECTED_VERSION=$(tr -d '\n\r' < "$REPO_ROOT/VERSION" 2>/dev/null || echo "")
    RUNNING_VERSION=$(printf '%s' "$HEALTH" | node -e 'let d="";process.stdin.on("data",c=>{d+=c});process.stdin.on("end",()=>{try{const b=JSON.parse(d);console.log(b&&b.status==="ok"&&typeof b.version==="string"?b.version:"")}catch{console.log("")}})')
    if [ "$RUNNING_VERSION" = "$EXPECTED_VERSION" ]; then
        if ! verify_data; then
            exit 1
        fi
        echo "[OK] 已有 UGK Cockpit 服务在运行（版本 $RUNNING_VERSION），数据核对通过，直接复用。"
        echo "URL: $BASE_URL"
        echo "$HEALTH"
        exit 0
    fi
    echo "[ERROR] 端口 $PORT 已被占用，但响应无法验证为匹配版本的 UGK Cockpit（运行版本：${RUNNING_VERSION:-未知}，当前程序：${EXPECTED_VERSION:-未知}）。"
    echo "本脚本不会替换运行中的服务；请按 docs/LOCAL_SERVICE_RECOVERY.md 处理升级或占用。"
    exit 1
fi
if nc -z 127.0.0.1 "$PORT" 2>/dev/null; then
    echo "[ERROR] 端口 $PORT 已被其他进程占用，且不是健康的 UGK Cockpit 服务。"
    echo "请先处理占用端口的进程，再重新运行本脚本。"
    exit 1
fi

STAMP=$(date +%Y%m%d-%H%M%S)
LOG_OUT="$DATA_DIRECTORY/logs/service-$STAMP.log"
LOG_ERR="$DATA_DIRECTORY/logs/service-$STAMP.err.log"

echo "[START] 启动后台服务（数据目录：${DATA_DIRECTORY}）"
nohup node "$REPO_ROOT/src/main.mjs" --data-directory "$DATA_DIRECTORY" --port "$PORT" >>"$LOG_OUT" 2>>"$LOG_ERR" &
SERVICE_PID=$!

i=0
READY=0
while [ "$i" -lt 100 ]; do
    if curl -fsS --max-time 2 "$BASE_URL/health" >/dev/null 2>&1; then
        READY=1
        break
    fi
    if ! kill -0 "$SERVICE_PID" 2>/dev/null; then
        echo "[ERROR] 服务进程启动后立即退出，日志："
        tail -20 "$LOG_ERR" "$LOG_OUT" 2>/dev/null
        exit 1
    fi
    i=$((i + 1))
    sleep 0.3
done
if [ "$READY" != "1" ]; then
    echo "[ERROR] 服务在 30 秒内未就绪，日志："
    tail -20 "$LOG_ERR" "$LOG_OUT" 2>/dev/null
    exit 1
fi

# 新启动的服务也要先通过数据核对；失败时停掉刚启动的进程，不留下
# 一个跑在未核对数据上的后台服务。
if ! verify_data; then
    kill "$SERVICE_PID" 2>/dev/null || true
    echo "[NOTE] 已向刚才启动的服务进程（PID $SERVICE_PID）发送停止信号；未清理或重置数据目录。"
    exit 1
fi

echo "[OK] UGK Cockpit 已启动，数据核对通过。"
echo "URL: $BASE_URL"
echo "PID: $SERVICE_PID"
echo "数据目录: $DATA_DIRECTORY"
echo "日志: $LOG_OUT"
exit 0
