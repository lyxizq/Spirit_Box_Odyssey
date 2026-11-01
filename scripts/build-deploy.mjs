// 部署包构建脚本：混淆前端 JS + 压缩 CSS/HTML，产出可直接部署的目录与 zip。
// 用法：npm run build:deploy（或 node scripts/build-deploy.mjs）
// 产物：dist/spirit-box-odyssey-deploy-v<版本>/ 与同名 .zip（内容为项目根红框白名单，见 DEPLOY_FILES）
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import JavaScriptObfuscator from 'javascript-obfuscator';
import esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = PKG.version;
const OUT_DIR = path.join(ROOT, 'dist', `spirit-box-odyssey-deploy-v${VERSION}`);
const ZIP_PATH = `${OUT_DIR}.zip`;

// 部署包内容 = 截图红框白名单（data/ 运行时自动生成、docker/ docs/ 不对外）
const COPY_FILES = ['cover.png', 'cover.svg', 'favicon.png', 'favicon.svg', 'LICENSE', 'index.html', 'login.html', 'package.json'];
const COPY_DIRS = ['assets', 'server'];
const OBFUSCATE_JS = ['game.js', 'login.js', 'theme-boot.js'];
const MINIFY_CSS = ['styles.css'];

const human = (n) => n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`;

// javascript-obfuscator：中等强度平衡体积与运行性能；禁 eval（服务端 CSP 为 script-src 'self'）、
// 禁 self-defending/debugProtection（避免卡顿与控制台反调试干扰运营）、不重命名全局（三份 JS 与 HTML 按文件名引用）。
const obfuscateOptions = {
  compact: true,
  simplify: true,
  renameGlobals: false,
  identifierNamesGenerator: 'hexadecimal',
  unicodeEscapeSequence: false, // 文案为中文，转义会让体积爆炸
  stringArray: true,
  stringArrayThreshold: 0.75,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayIndexShift: true,
  stringArrayCallsTransform: true,
  stringArrayCallsTransformThreshold: 0.75,
  splitStrings: true,
  splitStringsChunkLength: 8,
  numbersToExpressions: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.35,
  deadCodeInjection: false,
  debugProtection: false,
  selfDefending: false,
  transformObjectKeys: false,
  disableConsoleOutput: false,
  sourceMap: false,
  inputSourceMap: undefined,
};

// HTML 保守压缩：仅去行首缩进与空行、保留换行（换行渲染为空格，等价原文，不碰 inline 间距）
function minifyHtml(code) {
  return code.split('\n').map((l) => l.trim()).filter((l) => l.length > 0).join('\n') + '\n';
}

async function processJs(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const out = JavaScriptObfuscator.obfuscate(src, { ...obfuscateOptions, inputSourceMap: undefined }).getObfuscatedCode();
  fs.writeFileSync(path.join(OUT_DIR, rel), out);
  return [src.length, out.length];
}

async function processCss(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const out = (await esbuild.transform(src, { loader: 'css', minify: true })).code;
  fs.writeFileSync(path.join(OUT_DIR, rel), out);
  return [src.length, out.length];
}

function copyPackageJson() {
  // 部署机只需要运行时字段：剥离 devDependencies 与构建脚本，保持零依赖安装
  const { devDependencies, scripts, ...rest } = PKG;
  const deploy = { ...rest, scripts: { start: scripts.start } };
  fs.writeFileSync(path.join(OUT_DIR, 'package.json'), JSON.stringify(deploy, null, 2) + '\n');
}

console.log(`== 部署包构建 v${VERSION} ==`);
fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.rmSync(ZIP_PATH, { force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

const report = [];
for (const dir of COPY_DIRS) {
  fs.cpSync(path.join(ROOT, dir), path.join(OUT_DIR, dir), { recursive: true });
  report.push([`${dir}/`, '-', '-']);
}
copyPackageJson();
report.push(['package.json', '-', '-（已剥离 devDependencies/build 脚本）']);
for (const file of COPY_FILES) {
  fs.copyFileSync(path.join(ROOT, file), path.join(OUT_DIR, file));
}
report.push(['HTML ×2', '-', '-（去缩进空行，保留换行）']);

for (const rel of OBFUSCATE_JS) {
  const [before, after] = await processJs(rel);
  report.push([rel, human(before), human(after), '混淆']);
}
for (const rel of MINIFY_CSS) {
  const [before, after] = await processCss(rel);
  report.push([rel, human(before), human(after), '压缩']);
}

// zip 内不套主目录（2026-10-31 用户指定）：进入产物目录打包，解压即得部署文件本身
execSync(`zip -rqX '../${path.basename(ZIP_PATH)}' .`, { cwd: OUT_DIR });

console.log('');
for (const [name, b, a, note = ''] of report) console.log(`  ${name.padEnd(14)} ${b.padStart(9)} → ${a.padStart(9)}  ${note}`.trimEnd());
const zipSize = fs.statSync(ZIP_PATH).size;
console.log(`\n  目录: ${path.relative(ROOT, OUT_DIR)}`);
console.log(`  压缩包: ${path.relative(ROOT, ZIP_PATH)}（${human(zipSize)}）`);
