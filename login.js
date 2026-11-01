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
        location.replace('/');
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
