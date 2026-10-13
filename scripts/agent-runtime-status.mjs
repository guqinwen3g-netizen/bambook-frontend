#!/usr/bin/env node
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
try {
  require('dotenv').config({ path: '.env.local', quiet: true });
} catch {
  // dotenv is available in normal Bambook installs; env vars still work without it.
}

const args = new Set(process.argv.slice(2));
const values = new Map();
for (const arg of process.argv.slice(2)) {
  const match = arg.match(/^--([^=]+)=(.*)$/);
  if (match) values.set(match[1], match[2]);
}

const DEFAULT_ENDPOINT = 'https://jiangsupanda.com/bambook';
const endpoint = (values.get('endpoint') || process.env.BAMBOOK_AGENT_STATUS_ENDPOINT || DEFAULT_ENDPOINT).replace(/\/$/, '');
const apiKey = values.get('api-key') || process.env.BAMBOOK_SDK_KEY || process.env.BAMBOOK_API_KEY || process.env.VITE_BAMBOOK_API_KEY || '';
const url = endpoint.endsWith('/api/agent/status') ? endpoint : `${endpoint}${endpoint.endsWith('/api') ? '' : '/api'}/agent/status`;

const host = new URL(url).hostname.toLowerCase();
const isLocalhost = ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(host);
if (isLocalhost) {
  console.error('Refusing to query localhost as Bambook business or Agent truth. Use the Bambook data center endpoint.');
  process.exit(2);
}

const headers = {};
if (apiKey) headers['X-Bambook-API-Key'] = apiKey;

const res = await fetch(url, { headers });
const text = await res.text();
if (!res.ok) {
  console.error(`Agent status request failed: HTTP ${res.status}`);
  console.error(text.slice(0, 800));
  process.exit(1);
}

const payload = JSON.parse(text);
const agent = payload.agent || {};
const summary = {
  url,
  dataSource: agent.dataSource || null,
  users: agent.users || null,
  tools: agent.tools ? {
    registered: agent.tools.registered,
    highRisk: agent.tools.highRisk,
  } : null,
  audit: agent.audit || null,
  runtimeMetrics: agent.runtimeMetrics ? {
    startedAt: agent.runtimeMetrics.startedAt,
    totalRuns: agent.runtimeMetrics.totalRuns,
    lastError: agent.runtimeMetrics.lastError,
  } : null,
};

console.log(JSON.stringify(summary, null, 2));
