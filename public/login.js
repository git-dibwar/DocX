const tabs = document.querySelectorAll('.tab');
const forms = document.querySelectorAll('.form');
const authMessage = document.getElementById('authMessage');

function show(view) {
  tabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.view === view));
  forms.forEach((form) => form.classList.toggle('active', form.id === view));
  authMessage.textContent = '';
}

tabs.forEach((tab) => tab.addEventListener('click', () => show(tab.dataset.view)));

document.getElementById('signup').addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = document.getElementById('signupEmail').value;
  const password = document.getElementById('signupPassword').value;

  const res = await fetch('/api/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();
  authMessage.textContent = data.message || data.error;
  if (res.ok) show('signin');
});

document.getElementById('signin').addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = document.getElementById('signinEmail').value;
  const password = document.getElementById('signinPassword').value;

  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();
  if (!res.ok) return (authMessage.textContent = data.error || 'Login failed.');

  localStorage.setItem('mono_token', data.token);
  window.location.href = '/workspace';
});
