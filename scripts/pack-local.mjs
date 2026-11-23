#!/usr/bin/env node
// 本地单机版独立打包（与 scripts/build-deploy.mjs 同口径：产物名不带版本号、zip 内不套主目录）：
//   node scripts/pack-local.mjs
// 产物：dist/spirit-box-odyssey-local/ 目录 + 同名 .zip——自包含，解压后双击 index.html 即玩
// （file://），也可放任意静态托管。结构：仓库三件套（game.js/styles.css/theme-boot.js/
// favicon/cover）+ assets/ + local/ 子目录（bundle、sql.js 引擎与许可、wasm 内联、样式、
// login 跳板）。index.html 取 local/index.html 去掉 <base> 行（包根布局无需上跳）。
// 只清 dist 下 spirit-box-odyssey-local*（部署包产物归 build-deploy 管，互不误删）。
// 注意：AI 记忆/协作文件（.claude/.zcode 等）严禁入包。

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, cpSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL = path.join(ROOT, 'local');
const DIST = path.join(ROOT, 'dist');
const OUT_NAME = 'spirit-box-odyssey-local';
const OUT_DIR = path.join(DIST, OUT_NAME);
const ZIP_PATH = `${OUT_DIR}.zip`;

// 前置：本地版构建产物必须最新
const bundle = path.join(LOCAL, 'local-bundle.js');
const b64 = path.join(LOCAL, 'vendor', 'sql-wasm-b64.js');
if (!existsSync(bundle) || !existsSync(b64)) {
  console.error('缺少构建产物：先跑 node scripts/build-local.mjs');
  process.exit(1);
}

// 只保留一份（2026-11-01 用户指定口径，同 build-deploy）：清掉本产物的历史目录与压缩包
if (existsSync(DIST)) {
  for (const name of readdirSync(DIST)) {
    if (name.startsWith(OUT_NAME)) rmSync(path.join(DIST, name), { recursive: true, force: true });
  }
}
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(path.join(OUT_DIR, 'local', 'vendor'), { recursive: true });

// 仓库三件套与静态资源
for (const f of ['game.js', 'styles.css', 'theme-boot.js', 'favicon.svg', 'favicon.png', 'cover.png', 'cover.svg']) {
  cpSync(path.join(ROOT, f), path.join(OUT_DIR, f));
}
cpSync(path.join(ROOT, 'assets'), path.join(OUT_DIR, 'assets'), { recursive: true });

// local/ 子树（源码 src 不入包，只带运行必需件；sql.js 是 MIT 第三方代码，许可随包分发）
cpSync(bundle, path.join(OUT_DIR, 'local', 'local-bundle.js'));
cpSync(b64, path.join(OUT_DIR, 'local', 'vendor', 'sql-wasm-b64.js'));
cpSync(path.join(LOCAL, 'vendor', 'sql-wasm.js'), path.join(OUT_DIR, 'local', 'vendor', 'sql-wasm.js'));
cpSync(path.join(LOCAL, 'vendor', 'LICENSE.sql-js.txt'), path.join(OUT_DIR, 'local', 'vendor', 'LICENSE.sql-js.txt'));
cpSync(path.join(LOCAL, 'local.css'), path.join(OUT_DIR, 'local', 'local.css'));
cpSync(path.join(LOCAL, 'login.html'), path.join(OUT_DIR, 'login.html'));

// index.html：从生成的 local/index.html 去掉 <base> 行（包根布局无需上跳）
let html = readFileSync(path.join(LOCAL, 'index.html'), 'utf8');
if (!html.includes('<base href="../">') || !html.includes('local/local-bundle.js')) {
  console.error('local/index.html 不是 build-local.mjs 的生成形态（缺 <base> 或 bundle 引用），请先重新构建');
  process.exit(1);
}
html = html.replace('<base href="../">\n  ', '');
writeFileSync(path.join(OUT_DIR, 'index.html'), html);

const version = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

// 自述
writeFileSync(path.join(OUT_DIR, '说明.txt'), [
  '灵匣纪元 · 本地单机版 v' + version,
  '',
  '双击 index.html 即玩（进度保存在浏览器本地，不依赖任何服务器，也不需要联网）。',
  '· 换浏览器 / 换设备：游戏内左下角「存档」→ 导出备份文件 → 在新环境导入备份。',
  '· 进度与浏览器绑定：清理浏览器数据、使用无痕窗口都会丢失进度，请先导出备份。',
  '· 同一浏览器只开一个游戏标签页（多开会互相覆盖存档，游戏内会提示）。',
  '· 也可以把本目录整体放到任意静态托管上访问（同样全部在浏览器本地运行）。',
  '· 内置第三方组件：sql.js（SQLite 数据库引擎，MIT 许可，见 local/vendor/LICENSE.sql-js.txt）；',
  '  屏蔽词库来自开源项目 konsheng/Sensitive-lexicon（MIT），与服务端版同一份。',
].join('\n'));

// zip 内不套主目录（同部署包）：进入产物目录打包，压缩包落在上一级 dist/
execSync(`zip -rqX '../${path.basename(ZIP_PATH)}' .`, { cwd: OUT_DIR });

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MB';
const zipSize = statSync(ZIP_PATH).size;
console.log(`== 本地单机版打包 v${version} ==`);
console.log(`  目录: ${path.relative(ROOT, OUT_DIR)}（bundle ${kb(statSync(bundle).size)} + wasm 内联 ${kb(statSync(b64).size)}）`);
console.log(`  压缩包: ${path.relative(ROOT, ZIP_PATH)}（${mb(zipSize)}）`);
console.log('  自包含，解压后双击 index.html 即玩');
