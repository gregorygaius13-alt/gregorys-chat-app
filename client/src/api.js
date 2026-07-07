const TOKEN_KEY = 'kt_token';
const NAME_KEY = 'kt_username';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
export function getUsername() {
  return localStorage.getItem(NAME_KEY);
}
export function setSession(token, username) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(NAME_KEY, username);
}
export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(NAME_KEY);
}

async function request(path, options = {}) {
  const token = getToken();
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

export const api = {
  signup: (username, password) =>
    request('/api/auth/signup', { method: 'POST', body: JSON.stringify({ username, password }) }),
  login: (username, password) =>
    request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  getRooms: () => request('/api/rooms'),
  createRoom: (name) => request('/api/rooms', { method: 'POST', body: JSON.stringify({ name }) }),
  getMessages: (roomId) => request(`/api/rooms/${roomId}/messages`),
  getPushPublicKey: () => request('/api/push/public-key'),
  subscribePush: (subscription) => request('/api/push/subscribe', { method: 'POST', body: JSON.stringify(subscription) }),
  getUsers: () => request('/api/users'),
  uploadFile: async (file) => {
    const token = getToken();
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Upload failed.');
    return data; // { url, attachmentType }
  }
};
