// Node-only outbound guard for the isolated acceptance runner. Native engines
// are outside this guard; Prisma's database identity is checked separately.
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const root = process.env.BAMBOOK_ACCEPTANCE_SANDBOX;
const dbPort = Number(process.env.BAMBOOK_ACCEPTANCE_DB_PORT);
const noDatabase = process.env.BAMBOOK_ACCEPTANCE_NO_DATABASE === '1';
if (!root || (!noDatabase && (!Number.isInteger(dbPort) || dbPort < 1024))) throw Error('Acceptance guard requires an isolated sandbox and database port');
const allowedPorts = new Set(noDatabase ? [] : [dbPort]);
// The interactive runner supplies only its freshly reserved private API port
// to Vite. Ordinary test workers receive no cross-process HTTP allowance.
const privateUiApiPort = process.env.BAMBOOK_ACCEPTANCE_UI_API_PORT;
if (privateUiApiPort != null) {
  const port = Number(privateUiApiPort);
  if (noDatabase || !Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid private UI API port');
  allowedPorts.add(port);
}
const registeredServers = new WeakMap();
function registerServer(server) {
  const address = server.address();
  if (address && typeof address === 'object' && registeredServers.get(server) !== address.port) {
    registeredServers.set(server, address.port);
    allowedPorts.add(address.port);
    server.once('close', () => allowedPorts.delete(address.port));
  }
}
// The repository's B15 setup invokes _listen2 directly for Supertest sockets.
// Observe its actual bound address as well as public listen; do not alter binding.
const listenPrimitive = net.Server.prototype._listen2;
if (typeof listenPrimitive === 'function') net.Server.prototype._listen2 = function (...args) {
  const result = listenPrimitive.apply(this, args);
  registerServer(this);
  return result;
};
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const register = () => registerServer(this);
  this.once('listening', register);
  const result = listen.apply(this, args);
  // Supertest can request the synchronously assigned address before the
  // listening event runs; it is still a server created in this process.
  register();
  return result;
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const first = normalized[0];
  const options = typeof first === 'object' ? first : typeof first === 'number'
    ? { port: first, host: typeof normalized[1] === 'string' ? normalized[1] : 'localhost' }
    : { path: first };
  const host = String(options.host || 'localhost').toLowerCase();
  const local = ['localhost', '127.0.0.1', '::1', '[::1]', '::ffff:127.0.0.1'].includes(host);
  const permitted = options.path
    ? path.resolve(String(options.path)).startsWith(path.resolve(root) + path.sep)
    : local && allowedPorts.has(Number(options.port));
  if (!permitted) {
    const message = `Node network blocked: ${options.path ? 'socket outside sandbox' : host + ':' + options.port}`;
    fs.appendFileSync(path.join(root, 'network-denials.jsonl'), JSON.stringify({ at: new Date().toISOString(), host, port: options.port, message }) + '\n');
    throw Object.assign(new Error(message), { code: 'BAMBOOK_ACCEPTANCE_NETWORK_DENIED' });
  }
  return connect.apply(this, args);
};
