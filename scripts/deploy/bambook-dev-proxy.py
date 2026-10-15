#!/usr/bin/env python3
"""Development host only: build a sing-box config that sends OpenAI traffic through a user-supplied node.

Input  /etc/bambook-dev/proxy/nodes.txt (root 0600): share URLs (ss/vmess/vless/trojan/hysteria2/hy2/tuic),
       a base64 subscription body, an http(s) subscription link, or Shadowrocket/sing-box/Xray JSON.
Output /etc/sing-box/config.json; local mixed proxy on 127.0.0.1:7890. Only OpenAI domains use the node,
everything else goes direct. Never prints secrets.
Usage: bambook-dev-proxy apply | test
"""
import base64, json, os, subprocess, sys, urllib.parse, urllib.request

NODES = '/etc/bambook-dev/proxy/nodes.txt'
CONFIG = '/etc/sing-box/config.json'
LISTEN_PORT = 7890
OPENAI = ['openai.com', 'chatgpt.com', 'oaistatic.com', 'oaiusercontent.com', 'openai.org', 'auth0.com', 'sentry.io', 'livekit.cloud', 'featuregates.org', 'statsig.com']

def b64d(s):
    s = s.strip().replace('-', '+').replace('_', '/')
    return base64.b64decode(s + '=' * (-len(s) % 4)).decode('utf-8', 'replace')

def q(params, *names, default=None):
    for n in names:
        if n in params and params[n][0] != '':
            return params[n][0]
    return default

def tls_block(params, host, default_on=False):
    sec = q(params, 'security', default='tls' if default_on else '')
    if sec not in ('tls', 'reality', 'xtls') and not default_on:
        return None
    t = {'enabled': True, 'server_name': q(params, 'sni', 'peer', 'host', default=host),
         'insecure': q(params, 'allowInsecure', 'insecure', 'allow_insecure', default='0') in ('1', 'true')}
    alpn = q(params, 'alpn')
    if alpn:
        t['alpn'] = alpn.split(',')
    fp = q(params, 'fp')
    if fp or sec == 'reality':
        t['utls'] = {'enabled': True, 'fingerprint': fp or 'chrome'}
    if sec == 'reality':
        t['reality'] = {'enabled': True, 'public_key': q(params, 'pbk', default=''), 'short_id': q(params, 'sid', default='')}
    return t

def transport(params, host):
    net = q(params, 'type', 'net', 'obfs', default='tcp')
    path = urllib.parse.unquote(q(params, 'path', 'obfsParam', default='/') or '/')
    h = q(params, 'host', default='')
    if net in ('ws', 'websocket'):
        t = {'type': 'ws', 'path': path}
        if h:
            t['headers'] = {'Host': h}
        return t
    if net == 'grpc':
        return {'type': 'grpc', 'service_name': q(params, 'serviceName', 'path', default='')}
    if net in ('http', 'h2'):
        return {'type': 'http', 'path': path, **({'host': [h]} if h else {})}
    if net == 'httpupgrade':
        return {'type': 'httpupgrade', 'path': path, **({'host': h} if h else {})}
    return None

def parse_url(line):
    line = line.strip()
    scheme = line.split('://', 1)[0].lower()
    if scheme == 'vmess':
        body = line[8:].split('#', 1)[0]
        try:
            j = json.loads(b64d(body))
            params = {k: [str(v)] for k, v in j.items()}
            host, port = j['add'], int(j['port'])
            o = {'type': 'vmess', 'server': host, 'server_port': port, 'uuid': j['id'],
                 'security': j.get('scy') or 'auto', 'alter_id': int(j.get('aid') or 0)}
            if j.get('tls') in ('tls', True, '1'):
                params['security'] = ['tls']
        except Exception:
            # Shadowrocket style: vmess://base64(method:uuid@host:port)?params
            raw, _, qs = body.partition('?')
            dec = b64d(raw)
            cred, _, hp = dec.rpartition('@')
            method, _, uuid = cred.partition(':')
            host, _, port = hp.rpartition(':')
            params = urllib.parse.parse_qs(qs)
            if q(params, 'tls') in ('1', 'true'):
                params['security'] = ['tls']
            o = {'type': 'vmess', 'server': host, 'server_port': int(port), 'uuid': uuid,
                 'security': method or 'auto', 'alter_id': int(q(params, 'alterId', default='0'))}
        t = tls_block(params, host)
        if t: o['tls'] = t
        tr = transport(params, host)
        if tr: o['transport'] = tr
        return o
    u = urllib.parse.urlsplit(line)
    params = urllib.parse.parse_qs(u.query)
    if scheme == 'ss':
        if u.username and u.password is None and '@' in line:
            method, _, password = b64d(urllib.parse.unquote(u.username)).partition(':')
            host, port = u.hostname, u.port
        elif u.password is not None:
            method, password, host, port = urllib.parse.unquote(u.username), urllib.parse.unquote(u.password), u.hostname, u.port
        else:
            dec = b64d(line[5:].split('#', 1)[0].split('?', 1)[0])
            cred, _, hp = dec.rpartition('@')
            method, _, password = cred.partition(':')
            host, _, port = hp.rpartition(':')
            port = int(port)
        o = {'type': 'shadowsocks', 'server': host, 'server_port': int(port), 'method': method, 'password': password}
        plugin = q(params, 'plugin')
        if plugin:
            name, _, opts = urllib.parse.unquote(plugin).partition(';')
            o['plugin'] = 'obfs-local' if 'obfs' in name else name
            o['plugin_opts'] = opts
        return o
    host, port = u.hostname, u.port or 443
    user = urllib.parse.unquote(u.username or '')
    if scheme == 'vless':
        o = {'type': 'vless', 'server': host, 'server_port': port, 'uuid': user}
        flow = q(params, 'flow')
        if flow: o['flow'] = flow
        t = tls_block(params, host)
        if t: o['tls'] = t
        tr = transport(params, host)
        if tr: o['transport'] = tr
        return o
    if scheme == 'trojan':
        o = {'type': 'trojan', 'server': host, 'server_port': port, 'password': user,
             'tls': tls_block(params, host, default_on=True)}
        tr = transport(params, host)
        if tr: o['transport'] = tr
        return o
    if scheme in ('hysteria2', 'hy2'):
        pw = user if u.password is None else f'{user}:{urllib.parse.unquote(u.password)}'
        o = {'type': 'hysteria2', 'server': host, 'server_port': port, 'password': pw,
             'tls': tls_block(params, host, default_on=True)}
        if q(params, 'obfs') == 'salamander':
            o['obfs'] = {'type': 'salamander', 'password': q(params, 'obfs-password', 'obfsParam', default='')}
        return o
    if scheme == 'tuic':
        o = {'type': 'tuic', 'server': host, 'server_port': port, 'uuid': user,
             'password': urllib.parse.unquote(u.password or ''), 'congestion_control': q(params, 'congestion_control', default='bbr'),
             'tls': tls_block(params, host, default_on=True)}
        return o
    raise ValueError(f'unsupported scheme: {scheme}')

def from_shadowrocket(it):
    """Shadowrocket node export: {"type": "Socks5", "host": ..., "port": ..., "user": ..., "password": ...}."""
    kind = str(it.get('type', '')).lower().replace('-', '')
    host, port = it['host'], int(it['port'])
    user, pw = it.get('user') or '', it.get('password') or ''
    if kind in ('socks5', 'socks'):
        o = {'type': 'socks', 'server': host, 'server_port': port, 'version': '5'}
        if user: o.update(username=user, password=pw)
        return o
    if kind in ('http', 'https'):
        o = {'type': 'http', 'server': host, 'server_port': port}
        if user: o.update(username=user, password=pw)
        if kind == 'https': o['tls'] = {'enabled': True, 'server_name': it.get('peer') or host}
        return o
    if kind in ('shadowsocks', 'ss'):
        return {'type': 'shadowsocks', 'server': host, 'server_port': port, 'method': it.get('method') or 'aes-256-gcm', 'password': pw}
    if kind == 'trojan':
        return {'type': 'trojan', 'server': host, 'server_port': port, 'password': pw,
                'tls': {'enabled': True, 'server_name': it.get('peer') or host}}
    raise ValueError(f'Shadowrocket node type {it.get("type")!r} not supported; please export a share URL instead')

def from_json(data):
    if isinstance(data, dict) and isinstance(data.get('outbounds'), list):
        obs = [o for o in data['outbounds'] if o.get('type') not in ('direct', 'block', 'dns', 'selector', 'urltest', None)
               and o.get('protocol') not in ('freedom', 'blackhole', 'dns')]
        if obs and 'type' in obs[0]:
            return obs  # sing-box
        raise ValueError('Xray JSON is not supported; please export a share URL instead')
    items = data if isinstance(data, list) else [data]
    out = []
    for it in items:
        if isinstance(it, str):
            out.append(parse_url(it)); continue
        if isinstance(it.get('type'), str) and 'host' in it and 'port' in it:
            out.append(from_shadowrocket(it)); continue
        for k in ('url', 'uri', 'link', 'shareLink'):
            if isinstance(it.get(k), str) and '://' in it[k]:
                out.append(parse_url(it[k])); break
        else:
            raise ValueError('JSON node format not recognised; please export a share URL instead')
    return out

def load_nodes():
    raw = open(NODES, encoding='utf-8').read().strip()
    if not raw:
        raise ValueError(f'{NODES} is empty')
    if raw[0] in '[{':
        return from_json(json.loads(raw))
    lines = [l.strip() for l in raw.splitlines() if l.strip() and not l.startswith('#')]
    if len(lines) == 1 and lines[0].startswith(('http://', 'https://')):
        req = urllib.request.Request(lines[0], headers={'User-Agent': 'Shadowrocket'})
        body = urllib.request.urlopen(req, timeout=30).read().decode('utf-8', 'replace').strip()
        if body[:1] in '[{':
            return from_json(json.loads(body))
        lines = [l.strip() for l in (body if '://' in body else b64d(body)).splitlines() if '://' in l]
    elif len(lines) == 1 and '://' not in lines[0]:
        lines = [l.strip() for l in b64d(lines[0]).splitlines() if '://' in l]
    nodes = []
    for l in lines:
        try:
            nodes.append(parse_url(l))
        except Exception as e:
            print(f'skip one node: {e}', file=sys.stderr)
    if not nodes:
        raise ValueError('no usable node found')
    return nodes

def build(nodes):
    tags = []
    for i, n in enumerate(nodes):
        n = {k: v for k, v in n.items() if k != 'tag'}
        n['tag'] = f'node-{i + 1}'
        nodes[i] = n
        tags.append(n['tag'])
    group = {'type': 'urltest', 'tag': 'openai', 'outbounds': tags, 'url': 'https://chatgpt.com/cdn-cgi/trace', 'interval': '10m'} \
        if len(tags) > 1 else {'type': 'selector', 'tag': 'openai', 'outbounds': tags}
    return {
        'log': {'level': 'warn'},
        'dns': {'servers': [{'type': 'udp', 'tag': 'local', 'server': '119.29.29.29'}]},
        'inbounds': [{'type': 'mixed', 'tag': 'in', 'listen': '127.0.0.1', 'listen_port': LISTEN_PORT}],
        'outbounds': [{'type': 'direct', 'tag': 'direct'}, group] + nodes,
        'route': {'rules': [{'action': 'sniff'}, {'domain_suffix': OPENAI, 'outbound': 'openai'}],
                  'final': 'direct', 'default_domain_resolver': 'local'},
    }

def trace():
    r = subprocess.run(['curl', '-s', '-m', '20', '-x', f'http://127.0.0.1:{LISTEN_PORT}', 'https://chatgpt.com/cdn-cgi/trace'],
                       capture_output=True, text=True)
    loc = [l for l in r.stdout.splitlines() if l.startswith('loc=')]
    blocked = subprocess.run(['curl', '-s', '-m', '20', '-x', f'http://127.0.0.1:{LISTEN_PORT}', '-o', '/dev/null', '-w', '%{http_code}',
                              '-X', 'POST', '-H', 'content-type: application/json', '-d', '{}',
                              'https://auth.openai.com/api/accounts/deviceauth/usercode'], capture_output=True, text=True).stdout
    print(f"exit region: {loc[0][4:] if loc else 'unreachable'}; OpenAI auth endpoint HTTP {blocked or 'none'} (403 = region blocked)")

BACKEND_ENV = '/etc/bambook-dev/backend.env'
PROXY_ENV = {'HTTPS_PROXY': f'http://127.0.0.1:{LISTEN_PORT}', 'HTTP_PROXY': f'http://127.0.0.1:{LISTEN_PORT}',
             'NO_PROXY': 'localhost,127.0.0.1,::1', 'NODE_USE_ENV_PROXY': '1'}

def enable_backend_proxy():
    """Point both backend services at the local proxy (only after a node is configured); idempotent."""
    lines = open(BACKEND_ENV, encoding='utf-8').read().splitlines()
    keys = {l.split('=', 1)[0] for l in lines if '=' in l}
    missing = [f'{k}={v}' for k, v in PROXY_ENV.items() if k not in keys]
    if missing:
        with open(BACKEND_ENV, 'a', encoding='utf-8') as f:
            f.write('# OpenAI egress via local sing-box (bambook-dev-proxy)\n' + '\n'.join(missing) + '\n')
    for unit in ('bambook-dev.service', 'bambook-dev-mist.service'):
        subprocess.run(['systemctl', 'restart', unit], check=True)
    print('backend services restarted with the local proxy')

def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'apply'
    if os.geteuid() != 0:
        sys.exit('run as root')
    if cmd == 'apply':
        nodes = load_nodes()
        cfg = build(nodes)
        tmp = CONFIG + '.tmp'
        os.makedirs(os.path.dirname(CONFIG), exist_ok=True)
        with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as f:
            json.dump(cfg, f, indent=1)
        chk = subprocess.run(['sing-box', 'check', '-c', tmp], capture_output=True, text=True)
        if chk.returncode != 0:
            os.unlink(tmp)
            sys.exit('generated config rejected by sing-box: ' + chk.stderr.strip().splitlines()[-1][:300])
        os.replace(tmp, CONFIG)
        subprocess.run(['systemctl', 'enable', '--now', 'sing-box'], check=True, capture_output=True)
        subprocess.run(['systemctl', 'restart', 'sing-box'], check=True)
        print(f'{len(nodes)} node(s): ' + ', '.join(sorted({n["type"] for n in nodes})))
        subprocess.run(['sleep', '2'])
        trace()
        enable_backend_proxy()
    elif cmd == 'test':
        trace()
    else:
        sys.exit(__doc__)

if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, json.JSONDecodeError) as e:
        sys.exit(f'error: {e}')
