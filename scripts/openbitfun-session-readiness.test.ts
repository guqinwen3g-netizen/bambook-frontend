// Source-boundary regressions only. Live multi-turn/model context proof is separate.
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
const base='tmp/upstream/OpenBitFun/src/crates/interfaces/app-server/src/server/';
const host=readFileSync(base+'bambook_host.rs','utf8');
const fallback=readFileSync(base+'fallback.rs','utf8');
describe('embedded session readiness owner',()=>{
  it('routes the desktop readiness request into the runtime-backed host handler',()=>{
    expect(host.slice(0,host.indexOf('#[derive'))).toContain('"ensure_coordinator_session"');
    expect(fallback).toMatch(/matches!\(method\.as_str\(\),[^\n]+"ensure_coordinator_session"\)/);
    expect(fallback).toContain('bambook_host::session_read');
  });
  it('resolves the canonical persistence path before loading, never recreating or resetting a session',()=>{
    const branch=host.split('if method == "ensure_coordinator_session" {')[1].split('if method == "load_persisted_session_metadata"')[0];
    expect(branch).toContain('owner.resolve_persisted_session_storage_path(scope).await');
    expect(branch).toContain('owner.ensure_session_loaded_from_storage_path(');
    expect(branch).toContain('&storage_path, &request.session_id, request.include_internal');
    expect(branch).not.toMatch(/create_session|clear_session|delete_session/);
    expect(branch.indexOf('ensure_session_loaded_from_storage_path')).toBeLessThan(branch.indexOf('return Ok(Value::Null)'));
  });
  it('retains registered workspace identity, owner and remote-scope checks before readiness',()=>{
    const read=host.split('pub(super) async fn session_read(')[1].split('if method == "ensure_coordinator_session"')[0];
    expect(read).toContain('request.remote_connection_id.is_some() || request.remote_ssh_host.is_some()');
    expect(read).toContain('service.require_workspace(&request.workspace_id)');
    expect(read).toContain('WorkspaceKind::Remote');
    expect(read).toContain('owner.ensure_workspace_runtime_ownership(&scope)');
    expect(host).toContain('#[serde(default, alias = "include_internal")]');
  });
});
