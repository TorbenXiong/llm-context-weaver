import { build, context } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';

const watch = process.argv.includes('--watch');

const shared = { bundle: true, sourcemap: true, target: 'chrome120', logLevel: 'info' };

const entries = [
  // Service Worker（MV3，ESM）
  { ...shared, entryPoints: ['src/background/index.ts'], outfile: 'dist/background.js', format: 'esm' },
  // DeepSeek Content Script（DOM Adapter）
  { ...shared, entryPoints: ['src/providers/deepseek/index.ts'], outfile: 'dist/content/deepseek.js', format: 'iife' },
  // MAIN world 探针（读取主世界渲染的回复）
  { ...shared, entryPoints: ['src/providers/deepseek/mainProbe.ts'], outfile: 'dist/content/mainProbe.js', format: 'iife' },
  // React 工作台页面
  { ...shared, entryPoints: ['src/ui/main.tsx'], outfile: 'dist/ui/main.js', format: 'iife', jsx: 'automatic' },
];

await mkdir('dist/ui', { recursive: true });
await cp('public/manifest.json', 'dist/manifest.json');
await cp('src/ui/dashboard.html', 'dist/ui/dashboard.html');
await cp('src/ui/styles.css', 'dist/ui/styles.css');

if (watch) {
  const ctxs = await Promise.all(entries.map((o) => context(o)));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('watching for changes…');
} else {
  await Promise.all(entries.map((o) => build(o)));
}