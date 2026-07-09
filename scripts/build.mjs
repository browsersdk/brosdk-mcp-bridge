import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const srcDir = path.join(rootDir, 'src');
const distDir = path.join(rootDir, 'dist');
const defaultBaseUrl = 'http://mcp.brosdk.internal';

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });
await cp(srcDir, distDir, { recursive: true });

for (const fileName of ['background.js', 'popup.js', 'options.js']) {
  const filePath = path.join(distDir, fileName);
  const source = await readFile(filePath, 'utf8');
  await writeFile(
    filePath,
    source
      .replaceAll('__DEFAULT_MCP_BASE_URL__', defaultBaseUrl),
  );
}

console.log(`Built BroSDK MCP Bridge extension.`);
console.log(`MCP bridge host: ${defaultBaseUrl}`);
console.log(`Load unpacked directory: ${distDir}`);
