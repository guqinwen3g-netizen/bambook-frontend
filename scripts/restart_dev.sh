#!/bin/bash

# 定义颜色输出
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}Bambook Intelligent Hub - 一键重启前端开发环境${NC}"

# 1. 清理旧进程
echo -e "${BLUE}[1/4] 清理占用端口的旧进程...${NC}"
PIDS_3000=$(lsof -t -i:3000)
PIDS_8081=$(lsof -t -i:8081)

if [ -n "$PIDS_3000" ]; then
    echo "Killing processes on port 3000: $PIDS_3000"
    kill -9 $PIDS_3000 2>/dev/null
fi

if [ -n "$PIDS_8081" ]; then
    echo "Killing processes on port 8081: $PIDS_8081"
    kill -9 $PIDS_8081 2>/dev/null
fi

sleep 1

# 2. 后端说明
echo -e "${BLUE}[2/4] 使用 Bambook 数据中心 API；不启动本地后端${NC}"

# 3. 启动前端
echo -e "${BLUE}[3/4] 启动 Client Interface (Frontend)...${NC}"
npm run dev > client.log 2>&1 &
FRONTEND_PID=$!
echo -e "${GREEN}✅ 前端已在后台启动 (PID: $FRONTEND_PID), 日志: client.log${NC}"

# 4. 等待服务并打开浏览器
echo -e "${BLUE}[4/4] 等待服务就绪...${NC}"

# 简单的健康检查循环
MAX_RETRIES=30
COUNT=0
FRONTEND_READY=false

# 检查前端端口
COUNT=0
while [ $COUNT -lt $MAX_RETRIES ]; do
    if lsof -i:3000 > /dev/null; then
        FRONTEND_READY=true
        echo -e "${GREEN}✅ 前端服务就绪 (Port 3000)${NC}"
        break
    fi
    echo -n "."
    sleep 1
    COUNT=$((COUNT+1))
done

# 打开浏览器
if [ "$FRONTEND_READY" = true ]; then
    echo -e "${BLUE}🚀 打开浏览器预览...${NC}"
    # MacOS
    # open http://localhost:3000
else
    echo -e "${RED}❌ 前端启动失败，请检查 client.log${NC}"
fi

echo -e "${GREEN}开发环境重启完成。业务数据走 Bambook 数据中心。${NC}"
echo -e "查看日志: tail -f client.log"
