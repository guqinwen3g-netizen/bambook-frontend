#!/bin/bash
#
# safe-exec-wrapper.sh — Shell 层安全命令执行包装器
# 双重保险：timeout 命令 + 信号处理
#
# 用法：
#   ./safe-exec-wrapper.sh [options] <command>
#
# 选项：
#   -t, --timeout <秒>    超时时间（默认30秒）
#   -r, --retry <次数>    重试次数（默认0）
#   -d, --delay <秒>      重试间隔（默认1秒）
#   -b, --background      后台模式（立即返回，轮询检查）
#   -m, --marker <文件>   完成标记文件路径
#   -l, --log <文件>      日志文件路径
#   -q, --quiet           静默模式
#   -h, --help            显示帮助
#
# 示例：
#   ./safe-exec-wrapper.sh "ls -la"
#   ./safe-exec-wrapper.sh -t 10 "curl https://api.example.com"
#   ./safe-exec-wrapper.sh -b -m /tmp/task.done "./long-task.sh"
#

set -o pipefail

# 默认配置
TIMEOUT=30
RETRY=0
DELAY=1
BACKGROUND=false
MARKER=""
LOGFILE=""
QUIET=false

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 解析参数
while [[ $# -gt 0 ]]; do
  case $1 in
    -t|--timeout)
      TIMEOUT="$2"
      shift 2
      ;;
    -r|--retry)
      RETRY="$2"
      shift 2
      ;;
    -d|--delay)
      DELAY="$2"
      shift 2
      ;;
    -b|--background)
      BACKGROUND=true
      shift
      ;;
    -m|--marker)
      MARKER="$2"
      shift 2
      ;;
    -l|--log)
      LOGFILE="$2"
      shift 2
      ;;
    -q|--quiet)
      QUIET=true
      shift
      ;;
    -h|--help)
      show_help
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
    *)
      break
      ;;
  esac
done

# 剩余参数作为命令
COMMAND="$*"

# 显示帮助
show_help() {
  sed -n '2,25p' "$0" | sed 's/^# //'
}

# 日志输出
log() {
  if [ "$QUIET" = false ]; then
    echo -e "$1"
  fi
}

# 执行单次命令（带timeout）
exec_once() {
  local cmd="$1"
  local timeout="$2"
  local logfile="$3"
  
  local start_time=$(date +%s%3N)
  local exit_code=0
  local stdout=""
  local stderr=""
  local timed_out=false
  
  # 使用 timeout 命令执行
  if [ -n "$logfile" ]; then
    # 输出到日志文件
    timeout --signal=TERM --kill-after=5 "$timeout" bash -c "$cmd" > "$logfile" 2>&1
    exit_code=$?
    stdout=$(cat "$logfile" 2>/dev/null || echo "")
  else
    # 捕获输出
    stdout=$(timeout --signal=TERM --kill-after=5 "$timeout" bash -c "$cmd" 2>&1)
    exit_code=$?
  fi
  
  local end_time=$(date +%s%3N)
  local duration=$((end_time - start_time))
  
  # 检查是否超时
  if [ $exit_code -eq 124 ] || [ $exit_code -eq 137 ]; then
    timed_out=true
  fi
  
  # 返回结果（JSON格式）
  cat << EOF
{
  "success": $(if [ $exit_code -eq 0 ] && [ "$timed_out" = false ]; then echo "true"; else echo "false"; fi),
  "exitCode": $exit_code,
  "timedOut": $timed_out,
  "duration": $duration,
  "stdout": $(echo "$stdout" | jq -Rs '.'),
  "command": $(echo "$cmd" | jq -Rs '.')
}
EOF
}

# 带重试的执行
exec_with_retry() {
  local cmd="$1"
  local timeout="$2"
  local max_retries="$3"
  local delay="$4"
  local logfile="$5"
  
  local attempt=1
  local result=""
  
  while [ $attempt -le $((max_retries + 1)) ]; do
    log "${YELLOW}[attempt $attempt]${NC} Executing: ${cmd:0:50}..."
    
    result=$(exec_once "$cmd" "$timeout" "$logfile")
    local success=$(echo "$result" | jq -r '.success')
    
    if [ "$success" = "true" ]; then
      log "${GREEN}[success]${NC} Command completed in $(echo "$result" | jq -r '.duration')ms"
      echo "$result" | jq ".attempts = $attempt"
      return 0
    fi
    
    if [ $attempt -le $max_retries ]; then
      local timed_out=$(echo "$result" | jq -r '.timedOut')
      if [ "$timed_out" = "true" ]; then
        log "${RED}[timeout]${NC} Retrying in ${delay}s..."
      else
        log "${RED}[failed]${NC} Retrying in ${delay}s..."
      fi
      sleep "$delay"
      # 指数退避
      delay=$(echo "$delay * 1.5" | bc | cut -d. -f1)
      if [ "$delay" -gt 10 ]; then
        delay=10
      fi
    fi
    
    attempt=$((attempt + 1))
  done
  
  log "${RED}[failed]${NC} Command failed after $((max_retries + 1)) attempts"
  echo "$result" | jq ".attempts = $attempt"
  return 1
}

# 后台执行 + 轮询
exec_background() {
  local cmd="$1"
  local timeout="$2"
  local marker="$3"
  local logfile="$4"
  
  # 默认标记文件
  if [ -z "$marker" ]; then
    marker="/tmp/safe-exec-$(date +%s).done"
  fi
  
  # 默认日志文件
  if [ -z "$logfile" ]; then
    logfile="${marker}.log"
  fi
  
  # 清理旧文件
  rm -f "$marker" "$logfile"
  
  # 构建后台命令
  local bg_cmd="( $cmd ) > \"$logfile\" 2>&1 && echo 'DONE' > \"$marker\" || echo 'FAILED' > \"$marker\""
  
  log "${YELLOW}[background]${NC} Starting: ${cmd:0:50}..."
  log "${YELLOW}[background]${NC} Marker: $marker"
  log "${YELLOW}[background]${NC} Log: $logfile"
  
  # 启动后台进程
  nohup bash -c "$bg_cmd" > /dev/null 2>&1 &
  local pid=$!
  
  log "${YELLOW}[background]${NC} PID: $pid"
  
  # 轮询等待
  local poll_interval=1
  local max_polls=$timeout
  local polls=0
  local start_time=$(date +%s%3N)
  
  while [ $polls -lt $max_polls ]; do
    sleep $poll_interval
    polls=$((polls + 1))
    
    # 检查标记文件
    if [ -f "$marker" ]; then
      local status=$(cat "$marker" 2>/dev/null | tr -d '\n')
      local end_time=$(date +%s%3N)
      local duration=$((end_time - start_time))
      local stdout=$(cat "$logfile" 2>/dev/null || echo "")
      
      if [ "$status" = "DONE" ]; then
        log "${GREEN}[success]${NC} Task completed in ${duration}ms (${polls} polls)"
        cat << EOF
{
  "success": true,
  "exitCode": 0,
  "timedOut": false,
  "duration": $duration,
  "polls": $polls,
  "stdout": $(echo "$stdout" | jq -Rs '.'),
  "marker": "$marker"
}
EOF
        return 0
      else
        log "${RED}[failed]${NC} Task failed after ${duration}ms"
        cat << EOF
{
  "success": false,
  "exitCode": 1,
  "timedOut": false,
  "duration": $duration,
  "polls": $polls,
  "stdout": $(echo "$stdout" | jq -Rs '.'),
  "marker": "$marker"
}
EOF
        return 1
      fi
    fi
    
    # 每10秒输出进度
    if [ $((polls % 10)) -eq 0 ]; then
      local elapsed=$((polls * poll_interval))
      log "${YELLOW}[background]${NC} Still running... (${elapsed}s elapsed, ${polls} polls)"
    fi
  done
  
  # 超时
  local end_time=$(date +%s%3N)
  local duration=$((end_time - start_time))
  local stdout=$(cat "$logfile" 2>/dev/null || echo "")
  
  log "${RED}[timeout]${NC} Task timed out after ${duration}ms"
  cat << EOF
{
  "success": false,
  "exitCode": 124,
  "timedOut": true,
  "duration": $duration,
  "polls": $polls,
  "stdout": $(echo "$stdout" | jq -Rs '.'),
  "marker": "$marker"
}
EOF
  return 1
}

# 主逻辑
main() {
  # 检查命令
  if [ -z "$COMMAND" ]; then
    echo "Error: No command specified" >&2
    show_help
    exit 1
  fi
  
  # 检查 timeout 命令
  if ! command -v timeout &> /dev/null; then
    echo "Warning: 'timeout' command not found, using fallback" >&2
  fi
  
  # 后台模式
  if [ "$BACKGROUND" = true ]; then
    exec_background "$COMMAND" "$TIMEOUT" "$MARKER" "$LOGFILE"
    exit $?
  fi
  
  # 普通模式（带重试）
  exec_with_retry "$COMMAND" "$TIMEOUT" "$RETRY" "$DELAY" "$LOGFILE"
  exit $?
}

# 运行
main
