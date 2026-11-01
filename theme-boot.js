/*
 * 防主题闪烁（2026-10-31）：在首帧绘制前同步定主题。
 * 服务端 CSP 为 script-src 'self'，不能用内联脚本，故独立成文件，
 * 由 index.html 在 <body> 开头同步加载。
 * 2026-10-31 起本地不再落存档（云端唯一持久层），正题随云端档走；
 * 这里只读一个非存档的本地主题 hint（applyTheme 每次切换时写入），
 * 无 hint（新设备 / 清过缓存）默认亮色，进游戏后由 applyTheme 按云端档纠正。
 */
(function () {
  var light = true;
  try {
    light = localStorage.getItem('lingxia_theme') !== 'dark';
  } catch (e) { light = true; }
  if (light) {
    document.body.classList.add('theme-light');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', '#ccd2c0');
  }
})();
