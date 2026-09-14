import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';

const output = new URL('../dist/', import.meta.url);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(new URL('../public/', import.meta.url), output, { recursive: true });
await cp(new URL('../node-functions/', import.meta.url), new URL('./node-functions/', output), { recursive: true });

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
delete pkg.scripts;
delete pkg.devDependencies;
await writeFile(new URL('./package.json', output), `${JSON.stringify(pkg, null, 2)}\n`);
