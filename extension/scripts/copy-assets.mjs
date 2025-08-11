import fs from 'node:fs';
import path from 'node:path';

const srcDir = path.resolve('public');
const outDir = path.resolve('dist');

fs.mkdirSync(outDir, { recursive: true });
for (const entry of fs.readdirSync(srcDir)) {
  const source = path.join(srcDir, entry);
  const target = path.join(outDir, entry);
  fs.copyFileSync(source, target);
}
console.log('[FRL] copied assets');
