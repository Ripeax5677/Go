// Simple login page script
const discordLoginBtn = document.getElementById('discordLoginBtn');

discordLoginBtn.addEventListener('click', () => {
  window.location.href = '/auth/discord';
});

// If already logged in (token in localStorage), validate it and redirect to main page
async function checkLoginStatus() {
  const token = localStorage.getItem('userToken');
  if (!token) return; // Not logged in, stay on login page
  
  try {
    const res = await fetch('/api/me', { headers: { 'x-user-token': token } });
    if (res.status === 200) {
      // Token is valid, redirect to main page
      window.location.href = '/index.html';
    } else {
      // Token is invalid, remove it
      localStorage.removeItem('userToken');
    }
  } catch (e) {
    // Network error or invalid token, stay on login page
    localStorage.removeItem('userToken');
  }
}

checkLoginStatus();
