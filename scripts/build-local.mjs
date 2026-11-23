#!/usr/bin/env node
// 本地单机版构建：
//   node scripts/build-local.mjs
// 产物（全部入库，clone 即用，无需再构建）：
//   local/local-bundle.js       浏览器引导 bundle（esbuild IIFE：boot/shim/persist/ui +
//                               server/*.js 服务端模块原样 + db.js 经插件替身跑 sql.js）
//   local/vendor/sql-wasm-b64.js  wasm 内联（双击 file:// 免网络加载）
//   local/index.html            由根 index.html 机械变换生成（防两份 HTML 漂移）
//   local/.build/server.mjs     Node E2E 用入口（不入库，.gitignore）
// 改动本地版源码或服务端模块后重跑本脚本即可。

import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL = path.join(ROOT, 'local');
const SRC = path.join(LOCAL, 'src');
const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

// —— 插件：node 内置模块替身 + http-util 浏览器替身 ——
const STUBS = path.join(SRC, 'node-stubs.js');
const HTTP_SHIM = path.join(SRC, 'http-util-shim.js');
const nodeStubPlugin = {
  name: 'lx-local-node-stubs',
  setup(build) {
    build.onResolve({ filter: /^node:(fs|path|sqlite|url)$/ }, (args) => ({
      path: args.path,
      namespace: 'lx-stub',
    }));
    build.onLoad({ filter: /.*/, namespace: 'lx-stub' }, (args) => {
      const resolveDir = path.dirname(STUBS);
      if (args.path === 'node:sqlite') {
        return { contents: `export { DatabaseSync } from ${JSON.stringify(STUBS)};`, loader: 'js', resolveDir };
      }
      if (args.path === 'node:fs') {
        return { contents: `import { fsStub } from ${JSON.stringify(STUBS)}; export default fsStub;`, loader: 'js', resolveDir };
      }
      if (args.path === 'node:url') {
        return { contents: `export { fileURLToPath } from ${JSON.stringify(STUBS)};`, loader: 'js', resolveDir };
      }
      return { contents: `import { pathStub } from ${JSON.stringify(STUBS)}; export default pathStub;`, loader: 'js', resolveDir };
    });
  },
};
const httpUtilPlugin = {
  name: 'lx-local-http-util',
  setup(build) {
    // 服务端模块的 `import { sendJSON, SlidingWindow } from './http-util.js'` → 浏览器替身
    build.onResolve({ filter: /http-util\.js$/ }, () => ({ path: HTTP_SHIM }));
  },
};

// 词库虚拟模块：moderation.js 启动时用 fs.readdirSync / readFileSync 读
// server/lexicon/Vocabulary/*.txt（按它自身所在目录解析，真实服务端的 8000+ 屏蔽词来源）。
// 浏览器没有 fs——构建期把词库原文读进来交给 node-stubs 的 fs 替身，屏蔽词校验与真实
// 服务端同一份词库（改词库后重跑本脚本即同步）。目录缺失/为空直接让构建失败，
// 防止本地版悄悄退回只剩手写兜底词（2026-11-23 修复的就是这个静默降级）。
const LEXICON_DIR = path.join(ROOT, 'server', 'lexicon', 'Vocabulary');
const lexiconPlugin = {
  name: 'lx-local-lexicon',
  setup(build) {
    build.onResolve({ filter: /^lx-local:lexicon$/ }, () => ({ path: 'lx-local:lexicon', namespace: 'lx-lexicon' }));
    build.onLoad({ filter: /.*/, namespace: 'lx-lexicon' }, () => {
      const files = {};
      for (const name of readdirSync(LEXICON_DIR).filter((n) => n.toLowerCase().endsWith('.txt')).sort()) {
        files[name] = readFileSync(path.join(LEXICON_DIR, name), 'utf8');
      }
      if (!Object.keys(files).length) throw new Error('词库目录为空：' + LEXICON_DIR);
      return { contents: 'export const LEXICON = ' + JSON.stringify(files) + ';\n', loader: 'js' };
    });
  },
};

const common = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  // 中文文案与词库按 UTF-8 原样输出（默认 ascii 会把每个汉字转义成 \uXXXX，体积翻倍）；
  // 页面是 UTF-8、同文档加载的外链脚本继承文档编码，不会乱码
  charset: 'utf8',
  define: {
    __LX_LOCAL_VERSION__: JSON.stringify(VERSION),
    // db.js 的 journal 模式取环境变量——浏览器内存库固定 memory（sql.js 无 WAL 概念）
    'process.env.DB_JOURNAL': JSON.stringify('memory'),
  },
  plugins: [nodeStubPlugin, httpUtilPlugin, lexiconPlugin],
  logLevel: 'info',
};

// 1) 浏览器 bundle
await build({
  ...common,
  entryPoints: [path.join(SRC, 'boot.js')],
  outfile: path.join(LOCAL, 'local-bundle.js'),
});

// 2) wasm 内联（initSqlJs 的 wasmBinary 用；file:// 双击也能初始化）
const wasm = readFileSync(path.join(LOCAL, 'vendor', 'sql-wasm.wasm'));
writeFileSync(
  path.join(LOCAL, 'vendor', 'sql-wasm-b64.js'),
  '// 本地版构建产物：sql.js 引擎 wasm（vendor/sql-wasm.wasm 的 base64 内联），由 scripts/build-local.mjs 生成\n' +
  'window.__LX_SQL_WASM_B64 = ' + JSON.stringify(Buffer.from(wasm).toString('base64')) + ';\n',
);

// 3) local/index.html：由根 index.html 机械变换生成（防漂移）
const index = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let localIndex = index;
const mustReplace = (from, to) => {
  if (!localIndex.includes(from)) throw new Error('index.html 变换锚点缺失：' + from.slice(0, 60));
  localIndex = localIndex.replace(from, to);
};
mustReplace('<title>灵匣纪元 · Spirit Box Odyssey</title>',
  '<base href="../">\n  <title>灵匣纪元 · Spirit Box Odyssey · 单机版</title>');
mustReplace('<link rel="stylesheet" href="styles.css">',
  '<link rel="stylesheet" href="styles.css">\n  <link rel="stylesheet" href="local/local.css">');
mustReplace('<script src="game.js" defer></script>',
  [
    '  <!-- 本地单机版：sql.js 引擎（wasm 内联）+ 虚拟服务端 bundle；',
    '       服务端 API 由 bundle 内的 fetch shim 就地应答，game.js 由 bundle 按需注入 -->',
    '  <script src="local/vendor/sql-wasm.js"></script>',
    '  <script src="local/vendor/sql-wasm-b64.js"></script>',
    '  <script src="local/local-bundle.js"></script>',
  ].join('\n'));
mustReplace('<p>进度保存在云端，换设备登录同一账号自动恢复；设置页可重置存档。</p>',
  '<p>本地单机版：进度保存在<b>本浏览器</b>，不依赖服务器；左下角「存档」面板可导出 / 导入备份（换浏览器、换设备迁移用），设置页可重置存档。</p>');
writeFileSync(path.join(LOCAL, 'index.html'), localIndex);

// 4) Node E2E 入口（不入库）
mkdirSync(path.join(LOCAL, '.build'), { recursive: true });
await build({
  ...common,
  format: 'esm',
  platform: 'node',
  entryPoints: [path.join(SRC, 'server.js')],
  outfile: path.join(LOCAL, '.build', 'server.mjs'),
});

console.log('本地版构建完成：local/local-bundle.js / vendor/sql-wasm-b64.js / index.html / .build/server.mjs (v' + VERSION + ')');
