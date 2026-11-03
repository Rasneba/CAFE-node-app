(function () {
  const toast = document.getElementById('toast');
  const activateForm = document.getElementById('activateForm');
  const issueForm = document.getElementById('issueForm');
  const issueLocked = document.getElementById('issueLocked');
  let signedIn = false;

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(function () { toast.classList.remove('show'); }, 2600);
  }

  function fmt(value) {
    if (!value) return '-';
    const date = new Date(value);
    return isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  }

  function api(path, options) {
    const opts = Object.assign({ credentials: 'same-origin' }, options || {});
    if (opts.body && !opts.headers) opts.headers = { 'Content-Type': 'application/json' };
    return fetch(path, opts).then(async function (response) {
      const data = await response.json().catch(function () { return {}; });
      if (!response.ok) {
        const error = new Error((data.error && data.error.message) || 'Request failed');
        error.status = response.status;
        throw error;
      }
      return data;
    });
  }

  function renderLicense(license, machine) {
    const active = Boolean(license && license.active);
    const status = document.getElementById('licenseStatus');
    status.classList.toggle('active', active);
    document.getElementById('licenseTag').textContent = active ? 'Active' : 'Inactive';
    document.getElementById('licenseTag').className = 'erp-tag ' + (active ? 'green' : 'red');
    document.getElementById('licenseTitle').textContent = active ? 'License is active' : 'License is not active';
    document.getElementById('licenseReason').textContent = active
      ? 'This installation is licensed and ready to use.'
      : (license && license.reason) || 'Activate a key to license this installation.';
    document.getElementById('licenseSub').textContent = active ? 'Valid signed license installed.' : 'Activation required for this installation.';
    document.getElementById('machineId').textContent = machine || '-';
    document.getElementById('issuedTo').textContent = (license && license.issuedTo) || '-';
    document.getElementById('issuedAt').textContent = fmt(license && license.issuedAt);
    document.getElementById('expiresAt').textContent = fmt(license && license.expiresAt);
  }

  async function load() {
    try {
      const results = await Promise.all([
        api('/api/erp/license'),
        fetch('/api/auth/me', { credentials: 'same-origin' })
      ]);
      renderLicense(results[0].license, results[0].machine);
      if (results[1].ok) {
        const me = await results[1].json();
        signedIn = Boolean(me && me.user);
        const permissions = (me && me.permissions) || [];
        const canManage = permissions.indexOf('settings.manage') !== -1 || permissions.indexOf('*') !== -1 || (me.user && me.user.is_super_admin);
        if (signedIn && canManage) {
          issueForm.style.display = 'grid';
          issueLocked.style.display = 'none';
          document.getElementById('activateHint').textContent = 'Signed in as ' + me.user.email + '.';
        }
      }
    } catch (error) {
      document.getElementById('licenseTitle').textContent = 'Unable to load license';
      document.getElementById('licenseReason').textContent = error.message;
    }
  }

  activateForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    const button = document.getElementById('activateButton');
    const resultBox = document.getElementById('activateResult');
    button.disabled = true;
    button.textContent = 'Activating...';
    try {
      const data = await api('/api/erp/license/activate', {
        method: 'POST',
        body: JSON.stringify({ key: activateForm.key.value.trim() })
      });
      resultBox.classList.add('show');
      resultBox.innerHTML = '<div class="erp-tag green">License activated</div><div class="erp-license-key">Expires: ' + fmt(data.expiresAt) + (data.issuedTo ? '<br>Issued to: ' + data.issuedTo : '') + '</div>';
      showToast('License activated');
      load();
    } catch (error) {
      if (error.status === 401) {
        window.location.href = '/login?next=/license/activate';
        return;
      }
      resultBox.classList.add('show');
      resultBox.innerHTML = '<div class="erp-tag red">Activation failed</div><div class="erp-license-key">' + error.message + '</div>';
    } finally {
      button.disabled = false;
      button.textContent = 'Activate license';
    }
  });

  issueForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    const button = document.getElementById('issueButton');
    const resultBox = document.getElementById('issueResult');
    button.disabled = true;
    button.textContent = 'Generating...';
    try {
      const data = await api('/api/erp/license/issue', {
        method: 'POST',
        body: JSON.stringify({
          client: issueForm.client.value.trim(),
          tin: issueForm.tin.value.trim(),
          ttlDays: Number(issueForm.ttlDays.value || 365)
        })
      });
      resultBox.classList.add('show');
      resultBox.innerHTML = '<div class="erp-tag green">Key generated</div><div class="erp-license-key" id="generatedKey">' + data.key + '</div><button class="btn btn-small btn-outline" type="button" id="copyKey">Copy key</button>';
      document.getElementById('copyKey').addEventListener('click', function () {
        navigator.clipboard.writeText(data.key).then(function () { showToast('License key copied'); });
      });
      showToast('License key generated');
      load();
    } catch (error) {
      if (error.status === 401) {
        window.location.href = '/login?next=/license/activate';
        return;
      }
      resultBox.classList.add('show');
      resultBox.innerHTML = '<div class="erp-tag red">Could not issue key</div><div class="erp-license-key">' + error.message + '</div>';
    } finally {
      button.disabled = false;
      button.textContent = 'Generate license key';
    }
  });

  load();
})();
