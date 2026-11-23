// 本地版独立 UI：存档导出/导入悬浮面板 + 登出导航软化。
// 不触碰 game.js 的任何 DOM/逻辑，全部自持（挂 body 尾部，样式在 local.css）。

import { b64encode, b64decode, flushNow } from './persist.js';

const BACKUP_TYPE = 'lx-local-backup';

export function installUI({ server, version }) {
  const db = server.db;

  // ---------- 悬浮按钮 + 面板 ----------
  const btn = document.createElement('button');
  btn.id = 'lxLocalBtn';
  btn.type = 'button';
  btn.textContent = '存档';
  btn.title = '本地版存档：导出 / 导入 / 清空';
  document.body.appendChild(btn);

  const panel = document.createElement('div');
  panel.id = 'lxLocalPanel';
  panel.innerHTML = [
    '<div class="lx-panel-head"><b>本地版存档</b><button type="button" class="lx-x" id="lxLocalClose">×</button></div>',
    '<div class="lx-panel-body">',
    '  <p class="lx-hint">进度保存在本浏览器 localStorage，不依赖服务器。换浏览器 / 换设备时用「导出备份 → 导入备份」迁移。</p>',
    '  <div class="lx-row"><button type="button" id="lxExportFile">导出备份文件</button>',
    '  <button type="button" id="lxExportCopy">复制备份到剪贴板</button></div>',
    '  <div class="lx-row"><button type="button" id="lxImportPick">导入备份…</button>',
    '  <button type="button" id="lxWipe">清空本地数据</button></div>',
    '  <input type="file" id="lxImportFile" accept=".json,application/json" hidden>',
    '  <textarea id="lxImportText" placeholder="或把备份 JSON 粘贴到这里" hidden></textarea>',
    '  <div class="lx-row lx-import-row" hidden id="lxImportRow">',
    '    <button type="button" id="lxImportDo">确认导入（覆盖当前进度）</button></div>',
    '  <p class="lx-status" id="lxLocalStatus"></p>',
    '</div>',
  ].join('');
  document.body.appendChild(panel);

  const $ = (id) => panel.querySelector('#' + id);
  const status = $('lxLocalStatus');

  function paintStatus() {
    const n = db.exportBytes().length;
    status.textContent = '当前存档约 ' + (n / 1024).toFixed(0) + ' KB · 版本 v' + version;
  }

  btn.addEventListener('click', () => {
    panel.classList.toggle('open');
    paintStatus();
  });
  $('lxLocalClose').addEventListener('click', () => panel.classList.remove('open'));

  function backupJson() {
    return JSON.stringify({
      type: BACKUP_TYPE,
      v: 1,
      app: version,
      exportedAt: new Date().toISOString(),
      db: b64encode(db.exportBytes()),
    });
  }

  $('lxExportFile').addEventListener('click', () => {
    const blob = new Blob([backupJson()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const d = new Date();
    const p2 = (x) => String(x).padStart(2, '0');
    a.download = '灵匣纪元-本地备份-' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    status.textContent = '已导出备份文件';
  });

  $('lxExportCopy').addEventListener('click', async () => {
    const text = backupJson();
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = '备份已复制到剪贴板（' + Math.round(text.length / 1024) + ' KB）';
    } catch (e) {
      // 剪贴板权限被拒：落到粘贴框让用户手动复制
      const ta = $('lxImportText');
      ta.hidden = false;
      ta.value = text;
      ta.focus();
      ta.select();
      status.textContent = '已生成备份文本，请手动全选复制';
    }
  });

  $('lxImportPick').addEventListener('click', () => $('lxImportFile').click());
  $('lxImportFile').addEventListener('change', async () => {
    const f = $('lxImportFile').files && $('lxImportFile').files[0];
    if (!f) return;
    try {
      acceptImport(await f.text());
    } catch (e) {
      status.textContent = '读取文件失败：' + e.message;
    }
    $('lxImportFile').value = '';
  });
  $('lxImportText').addEventListener('change', () => {
    if ($('lxImportText').value.trim()) acceptImport($('lxImportText').value);
  });

  function acceptImport(text) {
    let body = null;
    try { body = JSON.parse(text); } catch (e) { /* fallthrough */ }
    if (!body || body.type !== BACKUP_TYPE || typeof body.db !== 'string') {
      status.textContent = '不是有效的本地版备份文件';
      return;
    }
    let bytes = null;
    try { bytes = b64decode(body.db); } catch (e) { /* fallthrough */ }
    if (!bytes || !bytes.length) {
      status.textContent = '备份数据段无法解析';
      return;
    }
    status.textContent = '备份 v' + body.v + ' · 应用版本 v' + body.app + ' · 导出于 ' + String(body.exportedAt || '').slice(0, 10) +
      '。确认导入将覆盖当前进度并重开页面。';
    $('lxImportRow').hidden = false;
    $('lxImportDo').onclick = async () => {
      try {
        db.importBytes(bytes); // 非法备份/版本错配在 importBytes 内拒绝（当前库不受影响）
      } catch (e) {
        status.textContent = '导入被拒绝：' + e.message;
        return;
      }
      await flushNow(db);
      location.reload();
    };
  }

  $('lxWipe').addEventListener('click', async () => {
    if (!window.confirm('清空本地数据？当前浏览器里的全部本地版进度（含云端格式无关的服务端账本）将删除且不可恢复。\n建议先导出备份。')) return;
    try {
      localStorage.removeItem('lx_local_db_v1');
      localStorage.removeItem('lx_local_db_v1.corrupt');
    } catch (e) { /* 忽略 */ }
    location.reload();
  });

  // ---------- 登出导航软化 ----------
  // 本地版无账号体系：游戏内「登出」「断服」会 location.replace('/login.html')。
  // 静态托管下那是服务端登录页或 404——这里拦截导航改为本地提示，不再跳走。
  if (window.navigation && typeof window.navigation.addEventListener === 'function') {
    try {
      window.navigation.addEventListener('navigate', (e) => {
        const url = (e.destination && e.destination.url) || '';
        if (/\/login\.html(\?|#|$)/.test(url) && !url.includes('/local/')) {
          e.intercept({
            handler: () => showExitMask(),
          });
        }
      });
    } catch (e) { /* 老浏览器无 Navigation API：登出会跳走，重开页面即可 */ }
  }

  function showExitMask() {
    let mask = document.getElementById('lxExitMask');
    if (!mask) {
      mask = document.createElement('div');
      mask.id = 'lxExitMask';
      mask.innerHTML = [
        '<div class="lx-exit-card">',
        '  <b>已退出本次修行</b>',
        '  <p>本地版没有账号体系：进度一直保存在本浏览器里，无需重新登录。</p>',
        '  <button type="button" id="lxExitBack">继续修行</button>',
        '</div>',
      ].join('');
      document.body.appendChild(mask);
      mask.querySelector('#lxExitBack').addEventListener('click', () => {
        mask.classList.remove('show');
      });
    }
    mask.classList.add('show');
  }
}
