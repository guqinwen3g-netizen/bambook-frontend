import { createLogger, format, transports, Logger } from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import TransportStream from 'winston-transport';

/**
 * Bambook Agent 结构化日志系统
 * - JSON 格式输出
 * - 支持 Trace ID 追踪
 * - 分离 Console 和 File 输出
 * - 按天轮转，保留 14 天，单文件 20MB 上限后切割
 * - error 级可外发 webhook 告警（BAMBOOK_ALERT_WEBHOOK_URL，默认关闭）
 */

// ─── error 级告警外发 ───────────────────────────────────────────────
// 设计约束：不引入外部 APM 依赖；失败绝不反噬日志管线；同源消息节流防告警风暴。
// 开关：BAMBOOK_ALERT_WEBHOOK_URL 非空才挂载 transport（默认关闭）。
// 节流：BAMBOOK_ALERT_THROTTLE_MS（默认 300000ms），同一 level+component+message 窗口内只发一次。
// 超时：单次外发 5s AbortController 截断，fire-and-forget。

const ALERT_THROTTLE_DEFAULT_MS = 300_000;
const ALERT_TIMEOUT_MS = 5_000;

interface AlertLogInfo {
    level: string;
    message: unknown;
    component?: string;
    traceId?: string;
    stack?: string;
    [key: string]: unknown;
}

class WebhookAlertTransport extends TransportStream {
    private readonly webhookUrl: string;
    private readonly throttleMs: number;
    private readonly lastSentAt = new Map<string, number>();

    constructor(opts: { webhookUrl: string; minLevel?: string; throttleMs?: number }) {
        super();
        this.webhookUrl = opts.webhookUrl;
        this.throttleMs = opts.throttleMs ?? ALERT_THROTTLE_DEFAULT_MS;
        this.level = opts.minLevel || 'error';
    }

    log(info: AlertLogInfo, next: () => void) {
        setImmediate(() => this.emit('logged', info));
        // fire-and-forget：告警通道故障绝不阻塞/反噬日志管线
        void this.sendAlert(info).catch(() => undefined);
        next();
    }

    private throttleKey(info: AlertLogInfo): string {
        const msg = typeof info.message === 'string' ? info.message : JSON.stringify(info.message);
        return `${info.level}:${info.component || 'SYSTEM'}:${msg.slice(0, 200)}`;
    }

    private async sendAlert(info: AlertLogInfo): Promise<void> {
        const key = this.throttleKey(info);
        const now = Date.now();
        const last = this.lastSentAt.get(key) || 0;
        if (now - last < this.throttleMs) return;
        this.lastSentAt.set(key, now);
        // 防 Map 无界增长：超过 1000 个 key 时整体重置（节流窗口短，影响可忽略）
        if (this.lastSentAt.size > 1000) this.lastSentAt.clear();

        const message = typeof info.message === 'string' ? info.message : JSON.stringify(info.message);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), ALERT_TIMEOUT_MS);
        try {
            await fetch(this.webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    source: 'bambook-main-api',
                    level: info.level,
                    component: info.component || 'SYSTEM',
                    traceId: info.traceId || 'N/A',
                    message: message.slice(0, 500),
                    stack: typeof info.stack === 'string' ? info.stack.slice(0, 1000) : undefined,
                    timestamp: new Date(now).toISOString()
                }),
                signal: controller.signal
            });
        } finally {
            clearTimeout(timer);
        }
    }
}


// 自定义格式：添加 traceId 和 component 字段
const customFormat = format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    format.errors({ stack: true }),
    format.printf(({ timestamp, level, message, traceId, component, ...meta }) => {
        const baseLog = {
            timestamp,
            level: level.toUpperCase(),
            component: component || 'SYSTEM',
            traceId: traceId || 'N/A',
            message,
            ...meta
        };
        return JSON.stringify(baseLog);
    })
);

// Console 格式（更易读）
const consoleFormat = format.combine(
    format.colorize(),
    format.timestamp({ format: 'HH:mm:ss' }),
    format.printf(({ timestamp, level, message, component }) => {
        const comp = component ? `[${component}]` : '';
        return `${timestamp} ${level} ${comp} ${message}`;
    })
);

// 创建 Logger 实例
const logger: Logger = createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: customFormat,
    defaultMeta: { service: 'bambook-agent' },
    transports: [
        // 控制台输出（更易读）— 仅在非生产环境
        new transports.Console({
            format: consoleFormat,
            level: 'debug'
        }),
        // 文件输出（结构化 JSON，按天轮转，保留 14 天，单文件 20MB 上限）
        new DailyRotateFile({
            filename: 'logs/bambook-error-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            maxSize: '20m',
            maxFiles: '14d',
            level: 'error'
        }),
        new DailyRotateFile({
            filename: 'logs/bambook-combined-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            maxSize: '20m',
            maxFiles: '14d'
        })
    ]
});

// 生产环境移除 Console 输出
if (process.env.NODE_ENV === 'production') {
    logger.remove(logger.transports[0]);
}

// error 级告警外发（默认关闭；BAMBOOK_ALERT_WEBHOOK_URL 非空才挂载）
const ALERT_WEBHOOK_URL = (process.env.BAMBOOK_ALERT_WEBHOOK_URL || '').trim();
if (ALERT_WEBHOOK_URL) {
    const throttleMs = Number(process.env.BAMBOOK_ALERT_THROTTLE_MS) || ALERT_THROTTLE_DEFAULT_MS;
    logger.add(new WebhookAlertTransport({
        webhookUrl: ALERT_WEBHOOK_URL,
        minLevel: (process.env.BAMBOOK_ALERT_MIN_LEVEL || 'error').trim(),
        throttleMs
    }));
}

/**
 * 创建带有 Trace ID 的子日志器
 */
export function createTraceLogger(traceId: string, component?: string) {
    return {
        info: (message: string, meta?: Record<string, any>) =>
            logger.info(message, { traceId, component, ...meta }),
        warn: (message: string, meta?: Record<string, any>) =>
            logger.warn(message, { traceId, component, ...meta }),
        error: (message: string, meta?: Record<string, any>) =>
            logger.error(message, { traceId, component, ...meta }),
        debug: (message: string, meta?: Record<string, any>) =>
            logger.debug(message, { traceId, component, ...meta })
    };
}

/**
 * 工具调用专用日志
 */
export function logToolExecution(
    traceId: string,
    toolName: string,
    status: 'start' | 'success' | 'error' | 'timeout',
    meta?: Record<string, any>
) {
    const emoji = {
        start: '🔧',
        success: '✅',
        error: '❌',
        timeout: '⏱️'
    }[status];

    logger.info(`${emoji} Tool [${toolName}] ${status}`, {
        traceId,
        component: 'TOOL',
        tool: toolName,
        status,
        ...meta
    });
}

export { logger };
export default logger;
