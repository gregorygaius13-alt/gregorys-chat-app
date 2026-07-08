const TOKEN_KEY = 'kt_token';
const NAME_KEY = 'kt_username';
const ADMIN_KEY = 'kt_is_admin';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
export function getUsername() {
  return localStorage.getItem(NAME_KEY);
}
export function getIsAdmin() {
  return localStorage.getItem(ADMIN_KEY) === 'true';
}
export function setSession(token, username, isAdmin) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(NAME_KEY, username);
  localStorage.setItem(ADMIN_KEY, isAdmin ? 'true' : 'false');
}
export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(NAME_KEY);
  localStorage.removeItem(ADMIN_KEY);
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
  resetPassword: (username, newPassword) =>
    request(`/api/users/${encodeURIComponent(username)}/reset-password`, { method: 'POST', body: JSON.stringify({ newPassword }) }),
  bootstrapAdmin: (secret) => request('/api/admin/bootstrap', { method: 'POST', body: JSON.stringify({ secret }) }),
  updateAvatar: (avatarUrl) => request('/api/users/me/avatar', { method: 'POST', body: JSON.stringify({ avatarUrl }) }),
  startDirectMessage: (username) => request(`/api/dm/${encodeURIComponent(username)}`, { method: 'POST' }),
  getPosts: () => request('/api/posts'),
  createPost: (text, mediaUrl, mediaType) =>
    request('/api/posts', { method: 'POST', body: JSON.stringify({ text, mediaUrl, mediaType }) }),
  viewPost: (postId) => request(`/api/posts/${postId}/view`, { method: 'POST' }),
  getPostViewers: (postId) => request(`/api/posts/${postId}/viewers`),
  reactToPost: (postId, reaction) => request(`/api/posts/${postId}/react`, { method: 'POST', body: JSON.stringify({ reaction }) }),
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
