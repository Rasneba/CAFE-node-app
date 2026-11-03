(function () {
  const form = document.getElementById('loginForm');
  const errorBox = document.getElementById('authError');
  const button = document.getElementById('loginButton');
  const params = new URLSearchParams(window.location.search);
  const next = params.get('next') || '/erp';

  function showError(message) {
    errorBox.textContent = message;
    errorBox.classList.add('show');
  }

  fetch('/api/auth/me', { credentials: 'same-origin' })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (data) {
      if (data && data.user) window.location.replace(next);
    })
    .catch(function () {});

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    errorBox.classList.remove('show');
    button.disabled = true;
    button.textContent = 'Signing in...';
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: form.email.value.trim(),
          password: form.password.value
        })
      });
      const data = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error((data.error && data.error.message) || 'Unable to sign in');
      window.location.replace(next);
    } catch (error) {
      showError(error.message || 'Unable to sign in');
      button.disabled = false;
      button.textContent = 'Sign in';
    }
  });
})();
