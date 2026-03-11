const state = {
  token: localStorage.getItem('token') || null,
  isActive: false
};

const authStatus = document.getElementById('authStatus');
const billingStatus = document.getElementById('billingStatus');
const processStatus = document.getElementById('processStatus');

function getHeaders() {
  return state.token ? { Authorization: `Bearer ${state.token}` } : {};
}

async function refreshMe() {
  if (!state.token) {
    authStatus.textContent = 'Not logged in.';
    billingStatus.textContent = 'No active subscription.';
    return;
  }

  const res = await fetch('/api/me', { headers: getHeaders() });
  if (!res.ok) {
    state.token = null;
    localStorage.removeItem('token');
    authStatus.textContent = 'Session expired.';
    return;
  }

  const data = await res.json();
  state.isActive = !!data.user.isActive;
  authStatus.textContent = `Logged in as ${data.user.email}`;
  billingStatus.textContent = state.isActive ? 'Subscription: Active' : 'Subscription: Inactive';
}

document.getElementById('registerBtn').onclick = async () => {
  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;
  const res = await fetch('/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();
  authStatus.textContent = res.ok ? `Registered user #${data.userId}. Please login.` : data.error;
};

document.getElementById('loginBtn').onclick = async () => {
  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();
  if (!res.ok) {
    authStatus.textContent = data.error;
    return;
  }

  state.token = data.token;
  localStorage.setItem('token', state.token);
  await refreshMe();
};

document.getElementById('logoutBtn').onclick = () => {
  state.token = null;
  localStorage.removeItem('token');
  state.isActive = false;
  refreshMe();
};

document.getElementById('subscribeBtn').onclick = async () => {
  if (!state.token) return (billingStatus.textContent = 'Login first.');

  const res = await fetch('/api/billing/create-checkout-session', {
    method: 'POST',
    headers: { ...getHeaders(), 'Content-Type': 'application/json' }
  });
  const data = await res.json();
  if (!res.ok) return (billingStatus.textContent = data.error || 'Stripe setup incomplete');

  window.location.href = data.url;
};

document.getElementById('mockActivateBtn').onclick = async () => {
  const res = await fetch('/api/billing/mock-activate', { method: 'POST', headers: getHeaders() });
  const data = await res.json();
  billingStatus.textContent = data.message || data.error;
  await refreshMe();
};

document.getElementById('processBtn').onclick = async () => {
  if (!state.token) return (processStatus.textContent = 'Login first.');
  if (!state.isActive) return (processStatus.textContent = 'Subscription required.');

  const file = document.getElementById('document').files[0];
  if (!file) return (processStatus.textContent = 'Select a DOCX or PDF file first.');

  const form = new FormData();
  form.append('document', file);

  document.querySelectorAll('fieldset input[type="checkbox"]').forEach((cb) => {
    form.append(cb.name, String(cb.checked));
  });

  processStatus.textContent = 'Processing...';
  const res = await fetch('/api/process', { method: 'POST', headers: getHeaders(), body: form });

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

  processStatus.textContent = 'Done. Download should start automatically.';
  await loadJobs();
};

async function loadJobs() {
  if (!state.token) return;
  const res = await fetch('/api/jobs', { headers: getHeaders() });
  if (!res.ok) return;

  const data = await res.json();
  const ul = document.getElementById('jobs');
  ul.innerHTML = '';

  data.jobs.forEach((job) => {
    const li = document.createElement('li');
    const enabled = Object.entries(job.options)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(', ');
    li.textContent = `${job.original_name} — ${job.status} — ${enabled || 'no options'} — ${job.created_at}`;
    ul.appendChild(li);
  });
}

document.getElementById('refreshJobsBtn').onclick = loadJobs;
refreshMe();
