/** 读取 text/event-stream，按事件回调已解析的 JSON（忽略非 JSON 与 [DONE]）。 */
export async function readSse(res: Response, onJson: (event: any) => void): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const handle = (raw: string) => {
    const data = raw.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n').trim();
    if (!data || data === '[DONE]') return;
    let parsed: unknown;
    try { parsed = JSON.parse(data); } catch { return; }
    onJson(parsed);
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let index: number;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        handle(raw);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) handle(buffer);
  } finally {
    reader.releaseLock();
  }
}
