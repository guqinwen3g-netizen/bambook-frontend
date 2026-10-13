import { getMcpManifest } from '../src/agent/mcp/manifest';
const tools = getMcpManifest();
console.log('total:', tools.length);
const byDomain: Record<string, number> = {};
for (const t of tools) byDomain[t.domain] = (byDomain[t.domain] || 0) + 1;
console.log('byDomain:', byDomain);
console.log('templates ids:', tools.filter(t => t.domain === 'templates').map(t => t.id));
