export type ToolOutcome = { status: 'success' } | { status: 'failed'; error: string };

/** Framework result envelopes are distinct from ordinary business rows with a status field. */
export function getToolOutcome(output: unknown, toolId: string): ToolOutcome {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return { status: 'success' };
  const value = output as Record<string, unknown>;
  const own = (key: string) => Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
  const preconditionsFailed = own('toolId') === toolId && own('status') === 'preconditions_failed'
    && Array.isArray(own('errors')) && typeof own('message') === 'string';
  if (own('ok') !== false && !preconditionsFailed) return { status: 'success' };
  const rawFeedback = own('errorFeedback');
  const feedback = rawFeedback && typeof rawFeedback === 'object' && !Array.isArray(rawFeedback)
    ? rawFeedback as Record<string, unknown> : {};
  const code = typeof feedback.code === 'string' ? feedback.code : 'TOOL_FAILED';
  const message = typeof feedback.message === 'string' ? feedback.message
    : typeof own('error') === 'string' ? own('error') as string
    : typeof own('message') === 'string' ? own('message') as string : '工具未确认成功';
  return { status: 'failed', error: `${code}: ${message}` };
}
