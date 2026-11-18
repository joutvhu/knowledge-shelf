import * as fs from 'node:fs';

const target = process.argv[2] || '';
if (!target || !fs.existsSync(target)) {
  console.error('Target directory missing:', target);
  process.exit(1);
}
console.log('Validated target:', target);
