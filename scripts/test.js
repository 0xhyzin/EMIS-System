import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Run each suite directly so its database hooks stay isolated and each assertion
// is reported even in environments that restrict the test runner's IPC workers.
const root = fileURLToPath(new URL('../', import.meta.url));
for (const file of readdirSync(new URL('../tests/', import.meta.url)).filter(name => name.endsWith('.test.js')).sort()) {
    const result = spawnSync(process.execPath, [`tests/${file}`], { cwd: root, stdio: 'inherit' });
    if (result.error) { console.error(result.error.message); process.exit(1); }
    if (result.status !== 0) process.exit(result.status || 1);
}
