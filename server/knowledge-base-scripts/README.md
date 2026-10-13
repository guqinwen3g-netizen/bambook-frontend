# 知识库脚本工具集

解决 WorkBuddy `execute_command` 卡住问题的实用工具集。

---

## 问题背景

WorkBuddy 在执行某些命令（SSH、chmod、长时间运行任务）时会卡住，且无法自动终止/重试。这个工具集提供多层保护来缓解这个问题。

---

## 工具清单

| 文件 | 用途 | 使用场景 |
|:---|:---|:---|
| `safe-exec.js` | Node.js 安全执行器 | 脚本内部调用，提供超时/重试/后台执行 |
| `safe-exec-wrapper.sh` | Shell 层双重保险 | 命令行直接执行，系统级 timeout 保护 |
| `link-document.js` | 原文档归档 | 归档文件到知识库（已增强健壮性） |
| `sync-to-ima.js` | IMA 同步 | 同步实体到腾讯 IMA（已增强健壮性） |

---

## 快速开始

### 1. 直接执行命令（带超时保护）

```bash
# 使用 Node.js 安全执行器
node safe-exec.js --timeout 10000 "curl https://api.example.com"

# 使用 Shell 包装器（双重保险）
./safe-exec-wrapper.sh -t 10 "curl https://api.example.com"
```

### 2. 后台执行（避免 WorkBuddy 卡住）

```bash
# Node.js 方式
node safe-exec.js --background --marker /tmp/task.done "./long-task.sh"

# Shell 方式
./safe-exec-wrapper.sh -b -m /tmp/task.done "./long-task.sh"
```

### 3. 自动重试

```bash
# 失败自动重试 3 次
node safe-exec.js --retry 3 "curl https://api.example.com"

# Shell 方式
./safe-exec-wrapper.sh -r 3 "curl https://api.example.com"
```

---

## 详细用法

### safe-exec.js

```javascript
const { execWithTimeout, retry, backgroundRun } = require('./safe-exec');

// 1. 简单超时执行
const result = await execWithTimeout('ls -la', { timeout: 5000 });
// result: { success, stdout, stderr, exitCode, timedOut, duration }

// 2. 自动重试
const result = await retry(
  () => execWithTimeout('curl ...', { timeout: 10000 }),
  3  // 重试3次
);

// 3. 后台执行 + 轮询
const result = await backgroundRun(
  'long-task.sh',
  '/tmp/task.done',  // 完成标记文件
  { timeout: 60000, pollInterval: 1000 }
);

// 4. 安全的数据库操作
const { safeDbOperation } = require('./safe-exec');
const result = await safeDbOperation(() => {
  return db.prepare('SELECT * FROM entities').all();
}, 10000);  // 10秒超时
```

### safe-exec-wrapper.sh

```bash
# 基础用法
./safe-exec-wrapper.sh "command"

# 选项
-t, --timeout <秒>    超时时间（默认30秒）
-r, --retry <次数>    重试次数（默认0）
-d, --delay <秒>      重试间隔（默认1秒）
-b, --background      后台模式
-m, --marker <文件>   完成标记文件
-l, --log <文件>      日志文件
-q, --quiet           静默模式

# 示例
./safe-exec-wrapper.sh -t 10 -r 3 "curl https://api.example.com"
./safe-exec-wrapper.sh -b -m /tmp/sync.done "node sync-to-ima.js --all"
```

### link-document.js

```bash
# 归档单个文件
node link-document.js --file /path/to/doc.pdf --entity <entity_id>

# 扫描整个目录
node link-document.js --scan /path/to/folder --entity <entity_id>

# 列出实体的文档
node link-document.js --list <entity_id>

# 预览模式（不实际写入）
node link-document.js --file doc.pdf --entity <id> --dry-run
```

### sync-to-ima.js

```bash
# 同步单个实体
node sync-to-ima.js --entity <entity_id>

# 同步所有实体
node sync-to-ima.js --all

# 预览模式
node sync-to-ima.js --entity <id> --dry-run
```

**配置 IMA 凭证：**

```bash
# 方式1: 环境变量
export IMA_OPENAPI_CLIENTID="your_client_id"
export IMA_OPENAPI_APIKEY="your_api_key"

# 方式2: 配置文件
mkdir -p ~/.config/ima
echo "your_client_id" > ~/.config/ima/credentials
echo "your_api_key" >> ~/.config/ima/credentials
```

---

## 分层防御策略

```
┌─────────────────────────────────────────┐
│  第一层：策略层（用户行为）                │
│  - 短命令优先（< 3秒）                   │
│  - 避免 SSH/长时间阻塞操作                │
│  - 卡住时立即记录，不重复尝试             │
├─────────────────────────────────────────┤
│  第二层：包装层（脚本封装）                │
│  - timeout 命令包装                      │
│  - 后台执行 + 轮询检查                    │
│  - 自动重试机制                          │
├─────────────────────────────────────────┤
│  第三层：应用层（脚本内部）                │
│  - 异步处理                              │
│  - 状态检查                              │
│  - 优雅降级                              │
└─────────────────────────────────────────┘
```

---

## WorkBuddy 最佳实践

### ✅ 推荐做法

```bash
# 1. 使用 timeout 包装
node safe-exec.js --timeout 5000 "command"

# 2. 后台执行长时间任务
node safe-exec.js --background --marker /tmp/done "long-command"

# 3. 本地文件操作代替远程命令
# 好：本地生成脚本，一次性上传执行
# 坏：多次 SSH 执行小命令

# 4. 批量操作代替循环
# 好：node link-document.js --scan ./folder --entity id
# 坏：循环调用 execute_command
```

### ❌ 避免做法

```bash
# 这些容易卡住：
ssh user@host "command"           # SSH 连接
chmod +x file                     # 文件权限修改
nohup command &                   # 后台进程
sleep 10                          # 长时间等待
# 任何可能阻塞的交互式命令
```

---

## 超时配置参考

| 操作类型 | 建议超时 | 说明 |
|:---|:---|:---|
| 简单文件操作 | 5秒 | stat, exists, mkdir |
| 数据库查询 | 10秒 | 一般查询 |
| 文件复制 | 30秒 | 普通文档 |
| 大文件复制 | 60秒 | >10MB 文件 |
| API 调用 | 30秒 | 网络请求 |
| 后台任务 | 60秒 | 轮询总时间 |

---

## 故障排查

### 命令卡住怎么办？

1. **用户手动取消**（Ctrl+C 或点击取消）
2. **检查日志**：查看 `.log` 文件了解执行状态
3. **使用后台模式**：下次用 `--background` 避免卡住
4. **缩短超时**：减少 `--timeout` 让失败更快暴露

### 如何验证工具正常工作？

```bash
# 测试超时功能（应该5秒后超时）
node safe-exec.js --timeout 5000 "sleep 10"

# 测试后台模式
node safe-exec.js --background --marker /tmp/test.done "echo hello > /tmp/test.txt"
cat /tmp/test.txt  # 应该看到 "hello"
```

---

## 更新记录

| 日期 | 更新 |
|:---|:---|
| 2026-04-17 | 初始版本，创建安全执行工具集 |

---

## 相关文件

- `safe-exec.js` — 核心安全执行器
- `safe-exec-wrapper.sh` — Shell 包装器
- `link-document.js` — 文档归档（已增强）
- `sync-to-ima.js` — IMA 同步（已增强）
