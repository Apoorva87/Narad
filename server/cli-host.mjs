// A child tied to the server's IPC lifetime, not a separate supervisor service.
import { spawn } from 'node:child_process';
let child;
function terminateGroup() { try { process.kill(-process.pid, 'SIGKILL'); } catch { child?.kill('SIGKILL'); process.exit(1); } }
process.on('disconnect', terminateGroup);
// Keep the helper alive while a CLI handles graceful shutdown; the parent
// still owns a group-wide hard-kill deadline for resistant descendants.
process.on('SIGTERM', () => { child?.kill('SIGTERM'); setTimeout(() => child?.kill('SIGKILL'), 1000).unref(); });
process.on('message', message => {
  if (child || message.type !== 'start') return;
  child = spawn(message.command, message.args, { cwd: message.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  child.stdin.on('error', () => {});
  child.once('spawn', () => { process.send?.({ type: 'started', pid: child.pid }); child.stdin.end(message.input); });
  child.once('error', error => { process.stderr.write(error.message); process.exitCode = 1; process.disconnect(); });
  // Pipe writes are asynchronous on macOS: let everything already piped reach the server before the group is killed.
  child.once('close', code => { process.send?.({ type: 'finished', code }); process.stdout.write('', () => process.stderr.write('', terminateGroup)); });
});
