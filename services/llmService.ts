import { KnowledgeItem, Order, Email, Insight } from "../types";

/**
 * llmService — 仅保留本地模板化的经营摘要。
 * 浏览器端 LLM 调用已全部退役：对话/洞察抽取统一走后端 AI Runtime
 * （Assistant 组件 /api/ai/chat、/api/ai/insights）。
 */
export const llmService = {
    /**
     * 生成经营摘要（本地模板化，基于真实订单/邮件/洞察计数计算）
     */
    async getExecutiveSummary(orders: Order[], emails: Email[], knowledge: KnowledgeItem[], insights: Insight[]) {
        const alertCount = orders.filter(o => o.status === 'Alert').length;
        const productionCount = orders.filter(o => o.status === 'Production').length;
        const shippingCount = orders.filter(o => o.status === 'Shipping').length;
        // 在跟订单 = 未交付（与 briefingService「在手订单」承揽口径一致；前端 Order 状态
        // 联合无 Cancelled，旧口径 orders.length 含已交付历史单，与看板简报数字打架）
        const openCount = orders.filter(o => !o.deletedAt && o.status !== 'Delivered').length;

        const statusPhrase = alertCount > 0
            ? `有 ${alertCount} 个紧急告警需要处理`
            : '运行平稳，暂无紧急告警';

        // R5 措辞：0 封邮件却报 N 条洞察自相矛盾——无邮件时只报洞察，不提邮件
        const insightPhrase = emails.length > 0
            ? `从 ${emails.length} 封往来邮件中识别出 ${insights.length} 条可执行洞察`
            : insights.length > 0 ? `识别出 ${insights.length} 条可执行洞察` : '暂无待处理洞察';
        return `经营概览：${statusPhrase}。当前在跟订单 ${openCount} 笔（生产中 ${productionCount} 笔，出运中 ${shippingCount} 笔）。${insightPhrase}。`;
    },
};
