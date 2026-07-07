import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import webpush from 'web-push';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import pool, { initDb } from './db.js';
import { hashPassword, checkPassword, signToken, verifyToken, requireAuth } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());

// ---------- Photo / voice-note uploads (Cloudinary) ----------
const uploadsEnabled = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET
);
if (uploadsEnabled) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
} else {
  console.warn('Cloudinary env vars not set — photo/voice sharing is disabled until configured.');
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

app.post('/api/upload', requireAuth, upload.single('file'), async (req, res) => {
  if (!uploadsEnabled) return res.status(503).json({ error: 'File sharing is not configured yet.' });
  if (!req.file) return res.status(400).json({ error: 'No file provided.' });
  try {
    const isAudio = req.file.mimetype.startsWith('audio/');
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { resource_type: isAudio ? 'video' : 'image', folder: 'gregorys-chat' }, // Cloudinary stores audio under 'video' resource type
        (err, result) => (err ? reject(err) : resolve(result))
      );
      stream.end(req.file.buffer);
    });
    res.json({ url: result.secure_url, attachmentType: isAudio ? 'audio' : 'image' });
  } catch (e) {
    console.error('Upload error', e);
    res.status(500).json({ error: 'Upload failed. Please try again.' });
  }
});

// ---------- Push notifications (VAPID key pair, no external account needed) ----------
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const pushEnabled = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (pushEnabled) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
} else {
  console.warn('VAPID keys not set — push notifications are disabled until VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY are configured.');
}

app.get('/api/push/public-key', (req, res) => {
  res.json({ publicKey: pushEnabled ? VAPID_PUBLIC_KEY : null });
});

app.post('/api/push/subscribe', requireAuth, async (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) return res.status(400).json({ error: 'Invalid subscription.' });
  try {
    await pool.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
      [req.user.id, endpoint, keys.p256dh, keys.auth]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not save subscription.' });
  }
});

// ---------- Auth ----------
app.post('/api/auth/signup', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || password.length < 6) {
    return res.status(400).json({ error: 'Username and a password of at least 6 characters are required.' });
  }
  try {
    const existing = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (existing.rows.length) return res.status(409).json({ error: 'That username is already taken.' });
    const hash = await hashPassword(password);
    const { rows } = await pool.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
      [username, hash]
    );
    const token = signToken(rows[0]);
    res.json({ token, username: rows[0].username });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Something went wrong creating your account.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (!rows.length) return res.status(401).json({ error: 'Incorrect username or password.' });
    const ok = await checkPassword(password, rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Incorrect username or password.' });
    const token = signToken(rows[0]);
    res.json({ token, username: rows[0].username });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Something went wrong signing you in.' });
  }
});

// ---------- Members ----------
app.get('/api/users', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT username, created_at FROM users ORDER BY created_at ASC'
  );
  res.json(rows);
});

// ---------- Rooms ----------
app.get('/api/rooms', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT id, name FROM rooms ORDER BY id ASC');
  res.json(rows);
});

app.post('/api/rooms', requireAuth, async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Room name required.' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO rooms (name) VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, name`,
      [name.trim()]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not create room.' });
  }
});

app.get('/api/rooms/:id/messages', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, username, text, attachment_url, attachment_type, created_at FROM messages WHERE room_id = $1 ORDER BY id ASC LIMIT 200',
    [req.params.id]
  );
  res.json(rows);
});

// ---------- Realtime ----------
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  const payload = token && verifyToken(token);
  if (!payload) return next(new Error('unauthorized'));
  socket.user = payload;
  next();
});

// socket.id -> { id, username } — used for presence and to avoid pushing to active viewers
const connectedUsers = new Map();

function broadcastPresence() {
  const names = [...new Set([...connectedUsers.values()].map((u) => u.username))];
  io.emit('presence', names);
}

io.on('connection', (socket) => {
  connectedUsers.set(socket.id, { id: socket.user.id, username: socket.user.username });
  broadcastPresence();

  socket.on('join_room', (roomId) => {
    socket.join(`room:${roomId}`);
  });

  socket.on('typing', ({ roomId }) => {
    if (!roomId) return;
    socket.to(`room:${roomId}`).emit('typing', { roomId, username: socket.user.username });
  });

  socket.on('mark_read', async ({ roomId, messageId }) => {
    if (!roomId || !messageId) return;
    try {
      await pool.query(
        `INSERT INTO room_reads (room_id, user_id, last_read_message_id) VALUES ($1, $2, $3)
         ON CONFLICT (room_id, user_id) DO UPDATE SET last_read_message_id = GREATEST(room_reads.last_read_message_id, EXCLUDED.last_read_message_id)`,
        [roomId, socket.user.id, messageId]
      );
      io.to(`room:${roomId}`).emit('read_update', { roomId, username: socket.user.username, messageId });
    } catch (e) {
      console.error(e);
    }
  });

  socket.on('send_message', async ({ roomId, text, attachmentUrl, attachmentType }) => {
    const cleanText = (text || '').trim();
    if (!roomId || (!cleanText && !attachmentUrl)) return;
    try {
      const { rows } = await pool.query(
        'INSERT INTO messages (room_id, user_id, username, text, attachment_url, attachment_type) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, username, text, attachment_url, attachment_type, created_at',
        [roomId, socket.user.id, socket.user.username, cleanText || null, attachmentUrl || null, attachmentType || null]
      );
      const message = rows[0];
      io.to(`room:${roomId}`).emit('new_message', { roomId, message });

      // Push-notify anyone not currently viewing this room
      if (pushEnabled) {
        const activeSocketIds = io.sockets.adapter.rooms.get(`room:${roomId}`) || new Set();
        const activeUserIds = new Set(
          [...activeSocketIds].map((sid) => connectedUsers.get(sid)?.id).filter(Boolean)
        );
        try {
          const roomRes = await pool.query('SELECT name FROM rooms WHERE id = $1', [roomId]);
          const roomName = roomRes.rows[0]?.name || 'New message';
          const subsRes = await pool.query('SELECT * FROM push_subscriptions WHERE user_id != $1', [socket.user.id]);
          for (const sub of subsRes.rows) {
            if (activeUserIds.has(sub.user_id)) continue; // already looking at this room
            const payload = JSON.stringify({
              title: roomName,
              body: `${socket.user.username}: ${cleanText || (attachmentType === 'audio' ? '🎤 Voice note' : '📷 Photo')}`,
              roomId,
            });
            webpush
              .sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload)
              .catch(async (err) => {
                if (err.statusCode === 404 || err.statusCode === 410) {
                  await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [sub.endpoint]);
                }
              });
          }
        } catch (e) {
          console.error('Push notification error', e);
        }
      }
    } catch (e) {
      console.error(e);
    }
  });

  socket.on('disconnect', () => {
    connectedUsers.delete(socket.id);
    broadcastPresence();
  });
});

// ---------- Serve frontend ----------
const clientDist = path.join(__dirname, '../client/dist');
app.use(express.static(clientDist));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(clientDist, 'index.html'));
});

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => {
    server.listen(PORT, () => console.log(`Family chat running on port ${PORT}`));
  })
  .catch((e) => {
    console.error('Failed to initialize database', e);
    process.exit(1);
  });
