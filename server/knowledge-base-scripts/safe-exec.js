#!/usr/bin/env node
/**
 * safe-exec.js — 安全命令执行包装器
 * 解决 WorkBuddy execute_command 卡住问题
 * 
 * 特性：
 * - 超时保护（默认30秒，可配置）
 * - 后台模式 + 轮询检查
 * - 自动重试机制
 * - 结构化返回结果
 * 
 * 用法：
 *   const { execWithTimeout, retry, backgroundRun } = require('./safe-exec');
 *   
 *   // 简单超时执行
 *   const result = await execWithTimeout('ls -la', { timeout: 5000 });
 *   
 *   // 自动重试
 *   const result = await retry(() => execWithTimeout('curl ...'), 3);
 *   
 *   // 后台执行 + 轮询
 *   const result = await backgroundRun('long-task.sh', '/tmp/task.done');
 */

const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('util');

const execPromise = util.promisify(exec);

// 默认配置
const DEFAULT_TIMEOUT = 30000; // 30秒
const DEFAULT_RETRY_DELAY = 1000; // 1秒
const DEFAULT_POLL_INTERVAL = 1000; // 1秒
const DEFAULT_MAX_POLLS = 60; // 最多轮询60次（1分钟）

/**
 * 执行命令，带超时保护
 * @param {string} command - 要执行的命令
 * @param {Object} options - 配置选项
 * @param {number} options.timeout - 超时时间（毫秒），默认30000
 * @param {boolean} options.shell - 是否使用shell，默认true
 * @param {string} options.cwd - 工作目录
 * @param {Object} options.env - 环境变量
 * @returns {Promise<{success: boolean, stdout: string, stderr: string, exitCode: number, timedOut: boolean, error?: Error}>}
 */
function execWithTimeout(command, options = {}) {
  const timeout = options.timeout || DEFAULT_TIMEOUT;
  const useShell = options.shell !== false;
  
  return new Promise((resolve) => {
    const startTime = Date.now();
    let timedOut = false;
    let killed = false;
    
    // 使用 spawn 获得更好的控制
    const child = useShell 
      ? spawn(command, { shell: true, cwd: options.cwd, env: { ...process.env, ...options.env } })
      : spawn(command.split(' ')[0], command.split(' ').slice(1), { cwd: options.cwd, env: { ...process.env, ...options.env } });
    
    let stdout = '';
    let stderr = '';
    
    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });
    
    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });
    
    // 超时定时器
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killed = true;
      // 先尝试温和终止
      child.kill('SIGTERM');
      
      // 3秒后强制终止
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, 3000);
    }, timeout);
    
    child.on('close', (exitCode, signal) => {
      clearTimeout(timeoutTimer);
      const duration = Date.now() - startTime;
      
      resolve({
        success: exitCode === 0 && !timedOut,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: exitCode || 0,
        signal,
        timedOut,
        killed,
        duration,
        command: command.substring(0, 100) // 记录前100字符用于调试
      });
    });
    
    child.on('error', (error) => {
      clearTimeout(timeoutTimer);
      resolve({
        success: false,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: -1,
        timedOut,
        error,
        duration: Date.now() - startTime,
        command: command.substring(0, 100)
      });
    });
  });
}

/**
 * 自动重试包装器
 * @param {Function} fn - 要执行的异步函数
 * @param {number} maxRetries - 最大重试次数，默认3
 * @param {number} delay - 重试间隔（毫秒），默认1000
 * @returns {Promise<any>}
 */
async function retry(fn, maxRetries = 3, delay = DEFAULT_RETRY_DELAY) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const result = await fn();
      
      // 如果返回的是我们的标准格式，检查 success 字段
      if (result && typeof result === 'object' && 'success' in result) {
        if (result.success) {
          return { ...result, attempts: attempt };
        }
        lastError = new Error(result.stderr || result.error?.message || 'Unknown error');
      } else {
        return { success: true, data: result, attempts: attempt };
      }
    } catch (error) {
      lastError = error;
    }
    
    if (attempt <= maxRetries) {
      console.log(`[retry] Attempt ${attempt} failed, retrying in ${delay}ms...`);
      await sleep(delay);
      // 指数退避
      delay = Math.min(delay * 1.5, 10000);
    }
  }
  
  return {
    success: false,
    error: lastError,
    attempts: maxRetries + 1,
    message: `Failed after ${maxRetries + 1} attempts: ${lastError.message}`
  };
}

/**
 * 后台执行 + 轮询检查
 * 适用于可能长时间运行的任务，避免 WorkBuddy 卡住
 * 
 * @param {string} command - 要执行的命令
 * @param {string} doneMarkerFile - 完成标记文件路径（任务完成时创建此文件）
 * @param {Object} options - 配置选项
 * @param {number} options.pollInterval - 轮询间隔（毫秒），默认1000
 * @param {number} options.maxPolls - 最大轮询次数，默认60
 * @param {number} options.timeout - 总超时时间（毫秒），默认60000
 * @returns {Promise<{success: boolean, stdout: string, duration: number, error?: string}>}
 */
async function backgroundRun(command, doneMarkerFile, options = {}) {
  const pollInterval = options.pollInterval || DEFAULT_POLL_INTERVAL;
  const maxPolls = options.maxPolls || DEFAULT_MAX_POLLS;
  const timeout = options.timeout || 60000;
  const logFile = options.logFile || `${doneMarkerFile}.log`;
  
  // 清理旧文件
  if (fs.existsSync(doneMarkerFile)) fs.unlinkSync(doneMarkerFile);
  if (fs.existsSync(logFile)) fs.unlinkSync(logFile);
  
  // 构建后台命令：执行原命令，完成后创建标记文件
  const backgroundCmd = `( ${command} ) > "${logFile}" 2>&1 && echo "DONE" > "${doneMarkerFile}" || echo "FAILED" > "${doneMarkerFile}"`;
  
  // 启动后台进程（使用 nohup 但立即返回）
  const startCmd = `nohup bash -c '${backgroundCmd.replace(/'/g, "'\"'\"'")}' > /dev/null 2>&1 &`;
  
  const startResult = await execWithTimeout(startCmd, { timeout: 5000 });
  
  if (!startResult.success) {
    return {
      success: false,
      error: `Failed to start background task: ${startResult.stderr}`,
      stdout: '',
      duration: 0
    };
  }
  
  console.log(`[backgroundRun] Task started, polling for completion...`);
  
  // 轮询等待完成
  const startTime = Date.now();
  let polls = 0;
  
  while (polls < maxPolls) {
    await sleep(pollInterval);
    polls++;
    
    const elapsed = Date.now() - startTime;
    
    // 检查总超时
    if (elapsed > timeout) {
      return {
        success: false,
        error: `Timeout after ${elapsed}ms`,
        stdout: readLogFile(logFile),
        duration: elapsed,
        polls
      };
    }
    
    // 检查完成标记
    if (fs.existsSync(doneMarkerFile)) {
      const marker = fs.readFileSync(doneMarkerFile, 'utf-8').trim();
      const stdout = readLogFile(logFile);
      
      return {
        success: marker === 'DONE',
        error: marker === 'FAILED' ? 'Task failed (check logs)' : undefined,
        stdout,
        duration: elapsed,
        polls
      };
    }
    
    // 每10秒输出一次进度
    if (polls % 10 === 0) {
      console.log(`[backgroundRun] Still running... (${elapsed}ms elapsed, ${polls} polls)`);
    }
  }
  
  return {
    success: false,
    error: `Max polls (${maxPolls}) reached`,
    stdout: readLogFile(logFile),
    duration: Date.now() - startTime,
    polls
  };
}

/**
 * 带超时的函数包装器
 * @param {Function} fn - 要执行的函数
 * @param {number} timeout - 超时时间（毫秒）
 * @param {string} timeoutMessage - 超时错误信息
 * @returns {Promise<any>}
 */
function withTimeout(fn, timeout, timeoutMessage = 'Operation timed out') {
  return Promise.race([
    fn(),
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error(timeoutMessage)), timeout)
    )
  ]);
}

/**
 * 安全的数据库操作包装器
 * @param {Function} dbOperation - 数据库操作函数
 * @param {number} timeout - 超时时间（毫秒），默认10000
 * @returns {Promise<{success: boolean, data?: any, error?: Error}>}
 */
async function safeDbOperation(dbOperation, timeout = 10000) {
  try {
    const result = await withTimeout(dbOperation, timeout, 'Database operation timed out');
    return { success: true, data: result };
  } catch (error) {
    return { success: false, error };
  }
}

/**
 * 安全的文件操作包装器
 * @param {Function} fileOperation - 文件操作函数
 * @param {number} timeout - 超时时间（毫秒），默认5000
 * @returns {Promise<{success: boolean, data?: any, error?: Error}>}
 */
async function safeFileOperation(fileOperation, timeout = 5000) {
  try {
    const result = await withTimeout(fileOperation, timeout, 'File operation timed out');
    return { success: true, data: result };
  } catch (error) {
    return { success: false, error };
  }
}

// 辅助函数
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readLogFile(logFile) {
  try {
    if (fs.existsSync(logFile)) {
      return fs.readFileSync(logFile, 'utf-8').trim();
    }
  } catch (e) {
    // ignore
  }
  return '';
}

// CLI 模式：直接执行命令
if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log(`
Usage: node safe-exec.js [options] <command>

Options:
  --timeout <ms>     Timeout in milliseconds (default: 30000)
  --retry <n>        Number of retries (default: 0)
  --background       Run in background with polling
  --marker <file>    Done marker file (for background mode)
  --help             Show this help

Examples:
  node safe-exec.js "ls -la"
  node safe-exec.js --timeout 5000 "curl https://api.example.com"
  node safe-exec.js --background --marker /tmp/done "long-running-task.sh"
`);
    process.exit(0);
  }
  
  const timeoutIdx = args.indexOf('--timeout');
  const timeout = timeoutIdx >= 0 ? parseInt(args[timeoutIdx + 1]) : DEFAULT_TIMEOUT;
  
  const retryIdx = args.indexOf('--retry');
  const retries = retryIdx >= 0 ? parseInt(args[retryIdx + 1]) : 0;
  
  const background = args.includes('--background');
  
  const markerIdx = args.indexOf('--marker');
  const marker = markerIdx >= 0 ? args[markerIdx + 1] : '/tmp/safe-exec-done';
  
  // 提取命令（非选项参数）
  const commandArgs = [];
  let skipNext = false;
  for (let i = 0; i < args.length; i++) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (args[i].startsWith('--')) {
      if (['--timeout', '--retry', '--marker'].includes(args[i])) {
        skipNext = true;
      }
      continue;
    }
    commandArgs.push(args[i]);
  }
  
  const command = commandArgs.join(' ');
  
  if (!command) {
    console.error('Error: No command specified');
    process.exit(1);
  }
  
  (async () => {
    let result;
    
    if (background) {
      result = await backgroundRun(command, marker, { timeout });
    } else if (retries > 0) {
      result = await retry(() => execWithTimeout(command, { timeout }), retries);
    } else {
      result = await execWithTimeout(command, { timeout });
    }
    
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.success ? 0 : 1);
  })();
}

module.exports = {
  execWithTimeout,
  retry,
  backgroundRun,
  withTimeout,
  safeDbOperation,
  safeFileOperation,
  sleep,
  DEFAULT_TIMEOUT,
  DEFAULT_RETRY_DELAY
};
