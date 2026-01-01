const adminLoginBtn = document.getElementById('adminLoginBtn');
const adminLogoutBtn = document.getElementById('adminLogoutBtn');
const adminUserName = document.getElementById('adminUserName');
const adminPassInput = document.getElementById('adminPassInput');
const usersTableBody = document.querySelector('#usersTable tbody');
const flipsList = document.getElementById('flipsList');

let adminToken = null;

async function loginAdmin() {
  const user = adminUserName.value || '';
  const pass = adminPassInput.value || '';
  try {
    const res = await fetch('/api/admin/login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ user, pass }) });
    if (res.status !== 200) {
      alert('Login failed');
      return;
    }
    const j = await res.json();
    adminToken = j.token;
    loadUsers();
    loadFlips();
  } catch (e) {
    console.error(e); alert('Login error');
  }
}

async function logoutAdmin() {
  adminToken = null;
  usersTableBody.innerHTML = '';
  flipsList.innerHTML = '';
}

async function loadUsers() {
  if (!adminToken) return;
  const res = await fetch('/api/admin/users', { headers: { 'x-admin-token': adminToken } });
  if (res.status !== 200) { alert('Unauthorized'); return; }
  const rows = await res.json();
  usersTableBody.innerHTML = '';
  for (const u of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${u.id}</td><td>${u.discordId}</td><td>${u.username}</td><td>${u.balance}</td><td>${u.banned ? 'Yes' : 'No'}</td><td></td>`;
    const actions = tr.querySelector('td:last-child');

    const setBtn = document.createElement('button'); setBtn.textContent='Set'; setBtn.className='smallBtn';
    setBtn.addEventListener('click', async () => {
      const v = Number(prompt('Set balance to', String(u.balance))||0);
      await fetch('/api/admin/setBalance', { method: 'POST', headers: {'Content-Type':'application/json','x-admin-token': adminToken}, body: JSON.stringify({ discordId: u.discordId, amount: v }) });
      loadUsers();
    });

    const addBtn = document.createElement('button'); addBtn.textContent='Add'; addBtn.className='smallBtn';
    addBtn.addEventListener('click', async () => {
      const v = Number(prompt('Add amount', '0')||0);
      await fetch('/api/admin/addBalance', { method: 'POST', headers: {'Content-Type':'application/json','x-admin-token': adminToken}, body: JSON.stringify({ discordId: u.discordId, amount: v }) });
      loadUsers();
    });

    const banBtn = document.createElement('button'); banBtn.textContent = u.banned ? 'Unban' : 'Ban'; banBtn.className = 'smallBtn ' + (u.banned ? 'unban' : 'ban');
    banBtn.addEventListener('click', async () => {
      const url = u.banned ? '/api/admin/unban' : '/api/admin/ban';
      await fetch(url, { method: 'POST', headers: {'Content-Type':'application/json','x-admin-token': adminToken}, body: JSON.stringify({ discordId: u.discordId }) });
      loadUsers();
    });

    actions.appendChild(setBtn); actions.appendChild(addBtn); actions.appendChild(banBtn);
    usersTableBody.appendChild(tr);
  }
}

async function loadFlips() {
  if (!adminToken) return;
  const res = await fetch('/api/logs', { headers: { 'x-admin-token': adminToken } });
  if (res.status !== 200) return;
  const rows = await res.json();
  flipsList.innerHTML = '';
  for (const r of rows.slice(0,100)) {
    const li = document.createElement('li');
    li.textContent = `${new Date(r.ts).toLocaleString()} — ${r.user || 'Anon'}: ${r.outcome}`;
    flipsList.appendChild(li);
  }
}

adminLoginBtn.addEventListener('click', loginAdmin);
adminLogoutBtn.addEventListener('click', logoutAdmin);

// auto-refresh every 10s when logged in
setInterval(() => { if (adminToken) { loadUsers(); loadFlips(); } }, 10000);
