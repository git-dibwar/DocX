const token = localStorage.getItem('mono_token');
const userState = document.getElementById('userState');
const billingStatus = document.getElementById('billingStatus');
const processStatus = document.getElementById('processStatus');

if (!token) window.location.href = '/login';

function headers() {
  return { Authorization: `Bearer ${localStorage.getItem('mono_token') || ''}` };
}

async function refresh() {
  const res = await fetch('/api/me', { headers: headers() });
  if (!res.ok) {
    localStorage.removeItem('mono_token');
    window.location.href = '/login';
    return;
  }

  const data = await res.json();
  userState.textContent = data.email;
  billingStatus.textContent = data.subscribed ? 'Plan: Active' : 'Plan: Inactive';
}

document.getElementById('logoutBtn').onclick = () => {
  localStorage.removeItem('mono_token');
  window.location.href = '/login';
};

document.getElementById('checkoutBtn').onclick = async () => {
  const res = await fetch('/api/billing/create-checkout-session', { method: 'POST', headers: headers() });
  const data = await res.json();
  if (!res.ok) return (billingStatus.textContent = data.error || 'Unable to open checkout.');
  window.location.href = data.url;
};

document.getElementById('mockActivateBtn').onclick = async () => {
  const res = await fetch('/api/billing/mock-activate', { method: 'POST', headers: headers() });
  const data = await res.json();
  if (!res.ok) return (billingStatus.textContent = data.error || 'Activation failed.');
  localStorage.setItem('mono_token', data.token);
  await refresh();
};

document.getElementById('processBtn').onclick = async () => {
  const file = document.getElementById('document').files[0];
  if (!file) return (processStatus.textContent = 'Choose a file first.');

  const form = new FormData();
  form.append('document', file);
  document.querySelectorAll('fieldset input[type="checkbox"]').forEach((box) => form.append(box.name, String(box.checked)));

  processStatus.textContent = 'Processing...';
  const res = await fetch('/api/process', { method: 'POST', headers: headers(), body: form });
  if (!res.ok) {
    const data = await res.json();
    processStatus.textContent = data.error || 'Processing failed.';
    return;
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${file.name.replace(/\.(docx|pdf)$/i, '')}-edited.${file.name.split('.').pop()}`;
  a.click();
  URL.revokeObjectURL(url);
  processStatus.textContent = 'Done. Temporary files were removed from server.';
};

refresh();
