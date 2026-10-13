#!/usr/bin/env node
/**
 * bambook-mcp-server.js — Bambook 项目 MCP Server
 * 
 * 功能：暴露 Bambook 项目的文件读写和命令执行能力
 * 协议：MCP over stdio (JSON-RPC)
 * 
 * 使用方式:
 *   node bambook-mcp-server.js
 * 
 * CodeBuddy 配置:
 *   {
 *     "mcpServers": {
 *       "bambook": {
 *         "command": "node",
 *         "args": ["/path/to/bambook-mcp-server.js"],
 *         "env": {}
 *       }
 *     }
 *   }
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');

// ========== 配置 ==========
const WORKSPACE_ROOT = '/Users/qinwengu/WorkBuddy/Claw/knowledge-base';
const PROJECT_NAME = 'Bambook';
// ==========================

// MCP 协议处理
let requestId = 0;

function sendResponse(id, result) {
  const response = JSON.stringify({ jsonrpc: '2.0', id, result });
  console.error('[MCP] Response:', response.substring(0, 100)); // debug log
  process.stdout.write(response + '\n');
}

function sendError(id, code, message) {
  const response = JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code, message }
  });
  process.stdout.write(response + '\n');
}

function sendNotification(method, params) {
  const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
  process.stdout.write(msg + '\n');
}

// ========== 工具函数 ==========
function normalizePath(inputPath) {
  // 安全检查：防止路径遍历
  let resolved = inputPath;
  if (!path.isAbsolute(inputPath)) {
    resolved = path.join(WORKSPACE_ROOT, inputPath);
  }
  
  // 确保路径在 WORKSPACE_ROOT 内
  const normalized = path.normalize(resolved);
  if (!normalized.startsWith(WORKSPACE_ROOT)) {
    throw new Error('路径必须在工作目录内: ' + WORKSPACE_ROOT);
  }
  return normalized;
}

// ========== MCP 工具定义 ==========
const tools = {
  // 读取文件
  read_file: {
    description: '读取文件内容',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '文件路径（绝对路径或相对于工作目录）' },
        limit: { type: 'number', description: '读取行数限制（可选）' },
        offset: { type: 'number', description: '起始行号（可选，从0开始）' }
      },
      required: ['filePath']
    },
    handler: async ({ filePath, limit, offset }) => {
      const fullPath = normalizePath(filePath);
      const content = fs.readFileSync(fullPath, 'utf-8');
      const lines = content.split('\n');
      return {
        content: limit || offset 
          ? lines.slice(offset || 0, (offset || 0) + (limit || lines.length)).join('\n')
          : content,
        lineCount: lines.length,
        path: fullPath
      };
    }
  },

  // 写入文件
  write_file: {
    description: '写入文件内容',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '文件路径' },
        content: { type: 'string', description: '文件内容' },
        append: { type: 'boolean', description: '是否追加模式（默认覆盖）' }
      },
      required: ['filePath', 'content']
    },
    handler: async ({ filePath, content, append }) => {
      const fullPath = normalizePath(filePath);
      const dir = path.dirname(fullPath);
      
      // 确保目录存在
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      if (append) {
        fs.appendFileSync(fullPath, content, 'utf-8');
      } else {
        fs.writeFileSync(fullPath, content, 'utf-8');
      }
      
      return {
        success: true,
        path: fullPath,
        size: fs.statSync(fullPath).size
      };
    }
  },

  // 列出目录
  list_directory: {
    description: '列出目录内容',
    inputSchema: {
      type: 'object',
      properties: {
        target_directory: { type: 'string', description: '目录路径' },
        ignore_globs: { type: 'array', items: { type: 'string' }, description: '忽略的文件模式' }
      },
      required: ['target_directory']
    },
    handler: async ({ target_directory, ignore_globs }) => {
      const fullPath = normalizePath(target_directory);
      const entries = fs.readdirSync(fullPath, { withFileTypes: true });
      
      return {
        entries: entries.map(entry => ({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
          path: path.join(fullPath, entry.name)
        })),
        count: entries.length,
        path: fullPath
      };
    }
  },

  // 搜索文件
  search_file: {
    description: '搜索文件',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '文件模式（如 *.js）' },
        target_directory: { type: 'string', description: '搜索目录' },
        recursive: { type: 'boolean', description: '是否递归搜索' }
      },
      required: ['pattern', 'target_directory']
    },
    handler: async ({ pattern, target_directory, recursive }) => {
      const results = [];
      const searchDir = normalizePath(target_directory);
      
      function matchesPattern(name, p) {
        const regex = new RegExp('^' + p.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
        return regex.test(name);
      }
      
      function walk(dir) {
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory() && recursive) {
              walk(fullPath);
            } else if (entry.isFile() && matchesPattern(entry.name, pattern)) {
              results.push({
                name: entry.name,
                path: fullPath,
                relative: path.relative(WORKSPACE_ROOT, fullPath)
              });
            }
          }
        } catch (e) {
          // 忽略权限错误
        }
      }
      
      walk(searchDir);
      return { results, count: results.length };
    }
  },

  // 搜索内容
  search_content: {
    description: '在文件中搜索内容',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式模式' },
        target_directory: { type: 'string', description: '搜索目录' },
        outputMode: { type: 'string', enum: ['files_with_matches', 'content'], default: 'files_with_matches' }
      },
      required: ['pattern', 'target_directory']
    },
    handler: async ({ pattern, target_directory, outputMode }) => {
      const results = [];
      const regex = new RegExp(pattern);
      const searchDir = normalizePath(target_directory);
      
      function walk(dir) {
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              walk(fullPath);
            } else if (entry.isFile()) {
              try {
                const content = fs.readFileSync(fullPath, 'utf-8');
                if (regex.test(content)) {
                  results.push({
                    path: fullPath,
                    relative: path.relative(WORKSPACE_ROOT, fullPath)
                  });
                }
              } catch (e) {
                // 忽略二进制文件
              }
            }
          }
        } catch (e) {
          // 忽略权限错误
        }
      }
      
      walk(searchDir);
      return { results, count: results.length };
    }
  },

  // 执行命令
  execute_command: {
    description: '执行终端命令',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        cwd: { type: 'string', description: '工作目录（可选）' }
      },
      required: ['command']
    },
    handler: async ({ command, cwd }) => {
      return new Promise((resolve) => {
        const workDir = cwd ? normalizePath(cwd) : WORKSPACE_ROOT;
        
        // 安全检查：只允许特定命令
        const allowedCommands = ['node', 'npm', 'git', 'ls', 'cat', 'grep', 'find', 'echo', 'pwd', 'cd', 'ls -la', 'git status'];
        const cmdName = command.split(' ')[0];
        
        if (!allowedCommands.some(c => command.startsWith(c))) {
          resolve({
            success: false,
            error: '命令未在白名单中允许',
            allowed: allowedCommands
          });
          return;
        }
        
        const child = spawn('/bin/zsh', ['-c', command], {
          cwd: workDir,
          env: { ...process.env, HOME: process.env.HOME }
        });
        
        let stdout = '';
        let stderr = '';
        
        child.stdout.on('data', (data) => { stdout += data.toString(); });
        child.stderr.on('data', (data) => { stderr += data.toString(); });
        
        child.on('close', (code) => {
          resolve({
            success: code === 0,
            exitCode: code,
            stdout: stdout.substring(0, 10000), // 限制输出长度
            stderr: stderr.substring(0, 1000)
          });
        });
        
        child.on('error', (err) => {
          resolve({
            success: false,
            error: err.message
          });
        });
        
        // 超时保护
        setTimeout(() => {
          child.kill();
          resolve({
            success: false,
            error: '命令执行超时（30秒）'
          });
        }, 30000);
      });
    }
  },

  // 获取项目信息
  get_project_info: {
    description: '获取 Bambook 项目信息',
    inputSchema: {
      type: 'object',
      properties: {}
    },
    handler: async () => {
      const packageJson = path.join(WORKSPACE_ROOT, '..', 'bambook-frontend', 'package.json');
      let packageInfo = {};
      
      try {
        packageInfo = JSON.parse(fs.readFileSync(packageJson, 'utf-8'));
      } catch (e) {
        packageInfo = { error: 'package.json not found' };
      }
      
      return {
        project: PROJECT_NAME,
        workspace: WORKSPACE_ROOT,
        version: packageInfo.version || 'unknown',
        description: packageInfo.description || 'Bambook 企业级 AI 数字大脑',
        capabilities: [
          'read_file',
          'write_file',
          'list_directory',
          'search_file',
          'search_content',
          'execute_command',
          'get_project_info'
        ]
      };
    }
  },

  // 健康检查
  health_check: {
    description: 'MCP Server 健康检查',
    inputSchema: {
      type: 'object',
      properties: {}
    },
    handler: async () => {
      return {
        status: 'ok',
        server: PROJECT_NAME,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        timestamp: new Date().toISOString()
      };
    }
  }
};

// ========== MCP 请求处理 ==========
function handleRequest(request) {
  const { id, method, params } = request;
  
  console.error('[MCP] Request:', method, params ? JSON.stringify(params).substring(0, 200) : ''); // debug
  
  // 初始化
  if (method === 'initialize') {
    sendResponse(id, {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {}
      },
      serverInfo: {
        name: 'bambook-mcp-server',
        version: '1.0.0'
      }
    });
    return;
  }
  
  // 工具调用
  if (method === 'tools/list') {
    const toolList = Object.entries(tools).map(([name, tool]) => ({
      name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }));
    sendResponse(id, { tools: toolList });
    return;
  }
  
  if (method === 'tools/call') {
    const { name, arguments: args } = params;
    const tool = tools[name];
    
    if (!tool) {
      sendError(id, -32601, `工具不存在: ${name}`);
      return;
    }
    
    try {
      tool.handler(args || {}).then(result => {
        sendResponse(id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        });
      }).catch(err => {
        sendError(id, -32603, `工具执行失败: ${err.message}`);
      });
    } catch (err) {
      sendError(id, -32603, `工具执行失败: ${err.message}`);
    }
    return;
  }
  
  // 未知方法
  sendError(id, -32601, `方法不存在: ${method}`);
}

// ========== 主循环 ==========
console.error(`[${PROJECT_NAME} MCP Server] 启动中...`);
console.error(`[${PROJECT_NAME} MCP Server] 工作目录: ${WORKSPACE_ROOT}`);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('line', (line) => {
  try {
    const request = JSON.parse(line);
    handleRequest(request);
  } catch (err) {
    console.error('[MCP] 解析错误:', err.message);
    // 尝试发送 JSON-RPC 错误
    try {
      sendError(null, -32700, 'Invalid JSON: ' + err.message);
    } catch (e) {
      // 忽略
    }
  }
});

rl.on('close', () => {
  console.error(`[${PROJECT_NAME} MCP Server] 关闭`);
  process.exit(0);
});

// 优雅关闭
process.on('SIGINT', () => {
  console.error(`[${PROJECT_NAME} MCP Server] 收到 SIGINT`);
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.error(`[${PROJECT_NAME} MCP Server] 收到 SIGTERM`);
  process.exit(0);
});

console.error(`[${PROJECT_NAME} MCP Server] 就绪，等待请求...`);
