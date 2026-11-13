// SPDX-License-Identifier: MIT
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { version } from './config.mjs';

export class Rpc {
  constructor(command, args, options = {}) {
    this.nextId = 0;
    this.pending = new Map();
    this.notifications = [];
    this.stderr = '';
    this.child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...options });
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-20000); });
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', (code, signal) => {
      this.fail(new Error(`RPC child exited (${code}, ${signal}) ${this.stderr.slice(-2000)}`));
      this.onExit?.();
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.method) {
        if (Object.hasOwn(message, 'id')) {
          Promise.resolve(this.onRequest?.(message) ?? Promise.reject(new Error(`Unsupported host request ${message.method}`)))
            .then(result => this.send({ jsonrpc: '2.0', id: message.id, result }), error => this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: error.message } }));
        } else {
          this.notifications.push(message);
          if (this.notifications.length > 200) this.notifications.shift();
          this.onNotification?.(message);
        }
        return;
      }
      // A multiplexer routes responses it forwarded under its own ids.
      this.onResponse?.(message);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = Object.assign(new Error(message.error.message), { rpc: message.error });
        pending.reject(error);
      } else pending.resolve(message.result);
    });
  }
  send(message) { if (!this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(message) + '\n'); }
  // The host is not draining. Stopping the backend's stdout lets its pipe fill
  // so it throttles itself, instead of this process buffering every token.
  pause() { if (!this.child.stdout.destroyed) this.child.stdout.pause(); }
  resume() { if (!this.child.stdout.destroyed) this.child.stdout.resume(); }
  request(method, params, timeout = 60000) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Timed out: ${method}; ${this.stderr.slice(-2000)}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }
  notify(method, params) { this.send({ jsonrpc: '2.0', method, params }); }
  fail(error) { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear(); }
  async close() {
    this.fail(new Error('RPC closed'));
    try { this.child.stdin.end(); } catch { /* already closed */ }
    if (this.child.exitCode === null) {
      await new Promise(resolve => {
        const timer = setTimeout(() => { try { this.child.kill(); } catch { /* already exited */ } resolve(); }, 3000);
        this.child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    try { this.lines.close(); } catch { /* already closed */ }
  }
}

export const initializeParams = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: 'raft-agent-adapter-probe', version },
  _meta: { startupHints: { nonInteractive: true, skipGitStatus: true, skipProjectLayout: true }, clientType: 'raft-daemon', clientVersion: '1.0.0' }
};
