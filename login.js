// 登录 / 注册页逻辑：标签切换、本地预校验、提交与错误展示
(function () {
  'use strict';

  var mode = 'login'; // login | register
  var $ = function (id) { return document.getElementById(id); };
  var form = $('authForm');
  var userInput = $('username');
  var passInput = $('password');
  var pass2Input = $('password2');
  var confirmField = $('confirmField');
  var errorBox = $('authError');
  var submitBtn = $('submitBtn');

  var USERNAME_RE = /^[A-Za-z0-9_\u4e00-\u9fa5]{2,16}$/;

  function setError(msg) {
    if (!msg) {
      errorBox.textContent = '';
      errorBox.classList.add('hidden');
      return;
    }
    errorBox.textContent = msg;
    errorBox.classList.remove('hidden');
  }

  function setMode(next) {
    mode = next;
    document.querySelectorAll('.auth-tab').forEach(function (tab) {
      tab.classList.toggle('active', tab.dataset.mode === next);
    });
    var isReg = next === 'register';
    confirmField.classList.toggle('hidden', !isReg);
    pass2Input.tabIndex = isReg ? 0 : -1;
    passInput.setAttribute('autocomplete', isReg ? 'new-password' : 'current-password');
    submitBtn.textContent = isReg ? '开宗立派' : '进入修行';
    setError('');
  }

  document.querySelectorAll('.auth-tab').forEach(function (tab) {
    tab.addEventListener('click', function () { setMode(tab.dataset.mode); });
  });

  function validate() {
    var username = userInput.value.trim();
    var password = passInput.value;
    if (!USERNAME_RE.test(username)) {
      return '道号需为 2-16 位中文、英文、数字或下划线';
    }
    if (password.length < 8 || password.length > 64 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
      return '口令需 8-64 位，且同时包含字母与数字';
    }
    if (mode === 'register' && pass2Input.value !== password) {
      return '两次输入的口令不一致';
    }
    return '';
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    if (submitBtn.disabled) return;
    setError('');
    var problem = validate();
    if (problem) { setError(problem); return; }

    submitBtn.disabled = true;
    submitBtn.textContent = mode === 'register' ? '开宗立派中…' : '进入中…';
    try {
      var res = await fetch('/api/auth/' + mode, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
        body: JSON.stringify({ username: userInput.value.trim(), password: passInput.value }),
      });
      var data = null;
      try { data = await res.json(); } catch (err) { data = null; }
      if (res.ok && data && data.ok) {
        // 200 只代表服务端已发 Set-Cookie；浏览器拒收 Cookie（被反代链路打成 Secure、
        // 禁 Cookie 等）时直接跳「/」会被 302 弹回登录页——无声循环极难自查。
        // 先复核会话确已建立再跳转，失败给出可行动的提示
        var me = null;
        var meStatus = 0;
        try {
          var meRes = await fetch('/api/auth/me', { credentials: 'same-origin' });
          meStatus = meRes.status;
          try { me = await meRes.json(); } catch (err2) { me = null; }
        } catch (err) { me = null; }
        // /api/auth/me 成功响应形如 {username, displayName, ...}（无 ok 字段）
        if (me && me.username) {
          location.replace('/');
          return;
        }
        // 5xx 是服务端异常，与会话 Cookie 无关：如实透传，避免把用户引去查浏览器设置
        // （2026-11-05 排查实录：陈旧进程 me 全量 500，Cookie 提示误导排查方向）
        if (meStatus >= 500) {
          setError('服务端异常（' + meStatus + (me && me.error ? '：' + me.error : '') + '），请稍后再试');
        } else {
          setError('登录态未能建立：请检查浏览器是否允许本站 Cookie（含隐身/无痕与浏览器拦截设置）');
        }
        submitBtn.disabled = false;
        submitBtn.textContent = mode === 'register' ? '开宗立派' : '进入修行';
        return;
      }
      setError((data && data.error) || '请求失败，请稍后再试');
    } catch (err) {
      setError('网络异常，请稍后再试');
    }
    submitBtn.disabled = false;
    submitBtn.textContent = mode === 'register' ? '开宗立派' : '进入修行';
  });

  // 游戏页检测到停机直接跳回（?down=1）：卡顶挂「游戏升级中」横幅
  if (new URLSearchParams(location.search).get('down') === '1') {
    var maint = $('maintBanner');
    if (maint) maint.classList.remove('hidden');
  }

  userInput.focus();
})();
