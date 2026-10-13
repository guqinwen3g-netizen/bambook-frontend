// Run through start-openbitfun.mjs --guard. This is a local fixture, not a live
// subscription acceptance test. Never import employee credentials or log headers.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

assert.equal(process.env.OPENBITFUN_E2E_STORAGE_GUARD, '1', 'Start the runtime and this smoke with isolated E2E storage roots');
assert.ok(process.env.OPENBITFUN_E2E_USER_ROOT && process.env.OPENBITFUN_E2E_HOME);
const marker = 'BAMBOOK_LOCAL_FIXTURE_REPLY';
let calls = 0, streamCalls = 0, browser, page, defaults, createdSessionId, configured = false;
const failures = new Set();
const fixture = createServer(async (req, res) => {
  try {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 2 * 1024 * 1024) throw new Error('Fixture request too large');
    }
    const body = JSON.parse(raw || '{}');
    calls += 1;
    if (body.stream) {
      streamCalls += 1;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const delta of [{ role: 'assistant' }, { content: marker }]) {
        res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'bambook-fixture', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      }
      res.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'bambook-fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', created: 1, model: 'bambook-fixture', choices: [{ index: 0, message: { role: 'assistant', content: marker }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    }
  } catch { res.writeHead(400).end(); }
});
async function rpc(method, params) {
  return page.evaluate(({ method, params }) => new Promise((resolve, reject) => {
    const socket = new WebSocket('ws://127.0.0.1:8080/ws');
    const timeout = setTimeout(() => { socket.close(); reject(new Error('RPC timeout')); }, 8000);
    socket.onopen = () => socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id === 1) {
        clearTimeout(timeout); socket.close();
        message.error ? reject(new Error(`RPC ${message.error.code}`)) : resolve(message.result);
      }
    };
    socket.onerror = () => { clearTimeout(timeout); socket.close(); reject(new Error('RPC transport failed')); };
  }), { method, params });
}
try {
  await new Promise((resolve, reject) => { fixture.once('error', reject); fixture.listen(18081, '127.0.0.1', resolve); });
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => console.error('BROWSER_EXCEPTION', error.message.slice(0, 240)));
  page.on('websocket', socket => {
    const pending = new Map();
    socket.on('framesent', frame => {
      try {
        const message = JSON.parse(frame.payload);
        pending.set(message.id, message.method);
        if (['bambook/createSession', 'bambook/updateSessionModel', 'manage_dialog_queue', 'agent/submitDialogTurn'].includes(message.method)) {
          console.log('RPC_CALL', message.method, message.params?.action ?? '');
        }
      } catch {}
    });
    socket.on('framereceived', frame => {
      try {
        const message = JSON.parse(frame.payload);
        const method = pending.get(message.id);
        if (message.error) failures.add(`${method}:${message.error.code}`);
        if (method === 'bambook/createSession' && message.result) createdSessionId = message.result.sessionId;
        if (['bambook/createSession', 'bambook/updateSessionModel', 'manage_dialog_queue', 'agent/submitDialogTurn'].includes(method)) {
          console.log('RPC_RESULT', method, message.error?.code ?? 'ok');
        }
        pending.delete(message.id);
      } catch {}
    });
  });
  await page.goto('http://127.0.0.1:1422');
  await page.getByRole('button', { name: 'More', exact: true }).first().click();
  await page.getByText('Open settings', { exact: true }).click();
  await page.getByText('Models', { exact: true }).first().click();
  await page.getByText('No API services configured yet', { exact: true }).waitFor();
  await page.getByText('No subscriptions imported yet', { exact: true }).waitFor();
  // Only a fresh, empty integration namespace is eligible for this fixture.
  // No reads of api_key, subscription storage, or other applications are made.
  defaults = await rpc('config/getConfig', { path: 'ai.default_models' });
  await rpc('config/setConfig', { path: 'ai.models', value: [{ id: 'bambook-local-fixture', name: 'Temporary local acceptance fixture', provider: 'openai', model_name: 'bambook-fixture', base_url: 'http://127.0.0.1:18081/v1', request_url: 'http://127.0.0.1:18081/v1/chat/completions', api_key: 'not-a-secret-test-fixture', enabled: true, category: 'general_chat', capabilities: ['text_chat', 'function_calling'], context_window: 128000, auth: { type: 'api_key' } }] });
  configured = true;
  await rpc('config/setConfig', { path: 'ai.default_models.primary', value: 'bambook-local-fixture' });
  console.log('PHASE fixture_configured');
  await page.reload();
  console.log('PHASE reloaded');
  await page.getByText('openbitfun-workspace', { exact: true }).first().hover();
  await page.getByRole('button', { name: /^New session$/i }).first().click();
  console.log('PHASE session_opened');
  await page.locator('[contenteditable=true]').waitFor();
  await page.locator('[contenteditable=true]').fill('Reply with the local acceptance marker. Do not use tools.');
  await page.locator('[contenteditable=true]').press('Enter');
  await page.locator('[data-openbitfun-component="flow-text-block"]').filter({ hasText: marker }).first().waitFor({ timeout: 25000 });
  assert.ok(calls > 0, 'No local model request was received');
  assert.ok(streamCalls > 0, 'No streaming request was received');
  assert.ok(createdSessionId, 'No real session identity was returned');
  console.log(JSON.stringify({ phase: 'streamed_reply_rendered', localFixtureCalls: calls, streamCalls }));
  const workspace = await rpc('get_current_workspace', {});
  assert.ok(workspace?.id, 'No registered workspace');
  await assert.rejects(() => rpc('restore_session_view', { sessionId: createdSessionId, workspacePath: '/unregistered-browser-path' }));
  await assert.rejects(() => rpc('restore_session_view', { sessionId: createdSessionId, workspaceId: workspace.id, remoteConnectionId: 'unsupported-test-remote' }));
  console.log('Registered-workspace and remote-scope rejection checks passed.');
  await page.screenshot({ path: 'tmp/upstream/openbitfun-local-fixture-chat.png' });
  await page.reload();
  // The upstream Web shell reopens its home screen, not the last tab. Select
  // the persisted session by identity, then require its actual message body.
  await page.locator(`[data-session-id=${JSON.stringify(createdSessionId)}]`).first().click();
  await page.locator('[data-openbitfun-component="flow-text-block"]').filter({ hasText: marker }).first().waitFor({ timeout: 25000 });
  await page.screenshot({ path: 'tmp/upstream/openbitfun-local-fixture-restored.png' });
  console.log(JSON.stringify({ localFixtureCalls: calls, streamedReplyRendered: true, persistedReplyRestored: true, unsupportedMethods: [...failures].filter(error => error.endsWith(':-32601')) }));
} catch (error) {
  console.error('SMOKE_FAILURE', error.message, 'localFixtureCalls', calls);
  if (page) console.error('CHAT_STATE', (await page.locator('body').innerText()).slice(-1800));
  console.error('RPC_ERRORS', [...failures]);
  process.exitCode = 1;
} finally {
  try {
    if (configured) {
      await rpc('config/setConfig', { path: 'ai.default_models', value: defaults });
      await rpc('config/setConfig', { path: 'ai.models', value: [] });
      console.log('Temporary fixture model removed; previous default selections restored.');
    }
  } catch (error) {
    console.error('ISOLATED_FIXTURE_CLEANUP_PENDING', error.message);
    process.exitCode = 1;
  } finally {
    await browser?.close();
    fixture.closeAllConnections();
    await new Promise(resolve => fixture.close(resolve));
  }
}
