const profileMenu = document.getElementById('profileMenu');
const profileBtn = document.getElementById('profileBtn');
const userLogoutBtn = document.getElementById('userLogoutBtn');

// Load user profile when page loads
async function loadUserProfile() {
  const token = localStorage.getItem('userToken') || window.userToken;

  // default behavior: clicking profile goes to login
  profileBtn.addEventListener('click', () => {
    if (!token) return (window.location.href = '/login.html');
  });

  const logoutVisibleBtn = document.getElementById('profileLogoutVisible');

  if (!token) return;

  try {
    const res = await fetch('/api/me', { headers: { 'x-user-token': token } });
    if (res.status !== 200) return;
    const data = await res.json();

    // set avatar (or fallback)
    profileBtn.src = data.avatar_url || 'https://cdn.discordapp.com/embed/avatars/0.png?size=128';

    // set small avatar and user meta on start panel
    const smallAv = document.getElementById('smallAvatar');
    const nameEl = document.getElementById('userNameDisplay');
    const balEl = document.getElementById('userBalanceDisplay');
    if (smallAv) smallAv.src = data.avatar_url || smallAv.src;
    if (nameEl) nameEl.textContent = data.username || nameEl.textContent;
    if (balEl) balEl.textContent = (data.balance != null) ? data.balance : balEl.textContent;

    // show visible logout button
    if (logoutVisibleBtn) logoutVisibleBtn.classList.remove('hidden');

    // clicking toggles menu
    profileBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      profileMenu.classList.toggle('hidden');
    });

    // hide on outside click
    document.addEventListener('click', (e) => {
      if (!profileMenu.contains(e.target) && e.target !== profileBtn) profileMenu.classList.add('hidden');
    });
  } catch (e) {
    console.error('Error loading profile:', e);
  }
}

// Logout handler — call server to clear cookie/session, then clear local token
userLogoutBtn.addEventListener('click', async () => {
  try {
    await fetch('/auth/logout');
  } catch (e) {
    console.warn('logout request failed', e);
  }
  localStorage.removeItem('userToken');
  window.userToken = null;
  window.location.href = '/login.html';
});

// visible logout button next to profile
const logoutVisibleBtn = document.getElementById('profileLogoutVisible');
if (logoutVisibleBtn) {
  logoutVisibleBtn.addEventListener('click', async () => {
    try { await fetch('/auth/logout'); } catch (e) { console.warn('logout', e); }
    localStorage.removeItem('userToken'); window.userToken = null; window.location.href = '/login.html';
  });
}

// Load profile on page load
loadUserProfile();
