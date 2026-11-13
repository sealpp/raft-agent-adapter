// SPDX-License-Identifier: MIT
// Route a Raft CLI call made inside the shared CodeBuddy backend to the agent
// that owns the current CodeBuddy session. CodeBuddy injects
// CODEBUDDY_SESSION_ID into tool processes; the adapter records the matching
// CLI transport when it opens the session.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { validSessionId, wrapperForSession } from './session-identity.mjs';

const name = process.argv[2];
const args = process.argv.slice(3);
if (!['raft', 'slock', 'cont'].includes(name)) {
  console.error('raft: unknown command ' + name);
  process.exit(2);
}

const sessionId = process.env.CODEBUDDY_SESSION_ID || process.env.CLAUDE_SESSION_ID || '';
if (!validSessionId(sessionId)) {
  console.error('raft: cannot identify the CodeBuddy session (CODEBUDDY_SESSION_ID is unset)');
  process.exit(3);
}

const transport = wrapperForSession(sessionId);
if (!transport) {
  console.error('raft: no Raft identity registered for session ' + sessionId);
  process.exit(3);
}

const suffixes = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
const target = suffixes.map(suffix => path.join(transport, name + suffix)).find(file => fs.existsSync(file));
if (!target) {
  console.error('raft: the ' + name + ' CLI wrapper is missing from this session transport');
  process.exit(3);
}

const result = spawnSync(target, args, {
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(target)
});
if (result.error) {
  console.error('raft: ' + result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
