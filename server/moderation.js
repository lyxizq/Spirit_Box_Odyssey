// 屏蔽词服务（2026-11-04 用户指令）：游戏内一切公开文本统一过本表校验——
// 显示名（auth.setDisplayName）/ 盟名与盟公告（social.guildCreate/guildNotice）/
// 注册道号（auth.register，display_name 初始回填自道号，公共可见）。
// 命中即拒绝并提示「不能含有屏蔽词」，词以响应 error 明示，客户端各输入点
// 的既有错误展示路径（floatText/表单报错）原样透出。
//
// 词库来源（2026-11-04 用户指令「网上找词库直接加载」+「改成加载 Vocabulary 目录下所有 txt」）：
// - lexicon/Vocabulary/*.txt = 开源库 konsheng/Sensitive-lexicon（MIT，2025-07 维护）的
//   分类词表原样入库（政治/反动/GFW/暴恐/涉枪涉爆/民生/广告/COVID/其他，10 个文件），
//   启动时扫描目录全部 *.txt 逐行加载——换库/加分类直接丢 txt 进目录即可，无需改代码。
//   注：不放 server/data/ 是因为 .gitignore 的 data/ 模式连 server/data/ 一起忽略，
//   词库会进不了 git 仓（GitHub 源码部署者缺文件）；lexicon/ 无此问题且随部署包分发。
// - 下方 HAND_WORDS = 手写兜底/补充（辱骂低俗为主，开源库覆盖较少的口语变体）；
//   目录缺失/无文件时仅用手写表兜底（启动打日志告警），服务不挂。
//   加载口径：一行一词，# 开头注释行跳过；单字条目跳过（防「操练/逼真」类误伤），
//   确需单字词加进 HAND_WORDS。
// 口径：小写化 + 剔除空白与常见分隔/装饰符后做包含匹配——挡「空格/符号拆词」
// 的最基本变体；谐音、形近字替换不做模糊匹配（误伤面大，入口低频够用）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 手写补充词（与 data/sensitive-words.txt 合并去重；单字仅留「屌」防误伤操作类常用词）
const HAND_WORDS = [
  // 辱骂 / 低俗
  '傻逼', '煞笔', '沙比', '傻比', '傻子', '蠢逼', '笨逼', '贱逼', '贱人', '贱货',
  '婊子', '婊砸', '母狗', '蠢猪', '死全家', '全家死', '畜生', '杂种', '滚蛋',
  '操你', '草你', '艹你', '干你', '日你', '肏你', '你妈', '妈的', '尼玛', '卧槽',
  '我操', '我草', '妈逼', '妈比', '鸡巴', '鸡吧', '屌', '逼你妈',
  // 色情补充
  '嫖娼', '卖淫', '做爱', '作爱', '性爱', '性交', '乱伦', '强奸', '轮奸',
  '色情', '黄片', '裸聊', '约炮', '一夜情', '援交', '啪啪',
];

// 归一化：小写 + 剔除空白/常见分隔与装饰符（挡「傻.逼」「f u c k」式拆词）
const STRIP_RE = /[\s\u3000·•*_.~～\-—=+@#$%^&()（）\[\]【】{}|\\/::;；,，。、!！?？"'`「」『』<>《》]+/g;

const LEXICON_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lexicon', 'Vocabulary');

function loadWords() {
  const set = new Set(HAND_WORDS);
  let fromFiles = 0;
  let files = 0;
  try {
    const names = fs.readdirSync(LEXICON_DIR).filter((n) => n.toLowerCase().endsWith('.txt')).sort();
    if (!names.length) throw new Error('目录无 txt 文件');
    for (const name of names) {
      for (const line of fs.readFileSync(path.join(LEXICON_DIR, name), 'utf8').split(/\r?\n/)) {
        const w = line.trim().toLowerCase();
        if (!w || w.startsWith('#') || w.length < 2 || set.has(w)) continue;
        set.add(w);
        fromFiles++;
      }
      files++;
    }
    console.log('[moderation] 敏感词库已加载 ' + set.size + ' 词（Vocabulary 目录 ' + files + ' 个文件 ' + fromFiles + ' 词 + 手写补充 ' + (set.size - fromFiles) + '）');
  } catch (e) {
    console.error('[moderation] 词库目录缺失/为空（' + LEXICON_DIR + '），仅用手写词表兜底：' + e.message);
  }
  return [...set];
}

const BANNED_WORDS = loadWords();

// 豁免表（2026-11-04 抽查定）：词库收录但游戏语境属正常词的条目——地名/机构/职业等
// （词库意图是拦「分裂组织/负面搭配」，纯地名与日常词不拦）。findBannedWord 命中后
// 先过此表：命中词全在豁免表 → 放行；玩家报误伤时往这里加词即可，不动词库文件。
const WHITELIST = new Set([
  '基督', '警察', '政府', '法院', '枪手', '台湾', '西藏', '新疆',
]);

// 返回命中的屏蔽词（未命中返回 null）。调用方拼进 error 文案提示用户。
// 先收集全部命中再滤豁免表（命中词全被豁免 = 放行），8600 词 includes 对低频入口开销可忽略
export function findBannedWord(text) {
  const t = String(text || '').toLowerCase().replace(STRIP_RE, '');
  if (!t) return null;
  const hits = [];
  for (const w of BANNED_WORDS) {
    if (t.includes(w)) hits.push(w);
  }
  for (const w of hits) {
    if (!WHITELIST.has(w)) return w;
  }
  return null;
}
