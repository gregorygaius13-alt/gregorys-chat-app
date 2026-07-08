import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import webpush from 'web-push';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import pool, { initDb } from './db.js';
import { hashPassword, checkPassword, signToken, verifyToken, requireAuth, requireAdmin } from './auth.js';

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
    const isVideo = req.file.mimetype.startsWith('video/');
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { resource_type: (isAudio || isVideo) ? 'video' : 'image', folder: 'gregorys-chat' }, // Cloudinary stores audio/video under the 'video' resource type
        (err, result) => (err ? reject(err) : resolve(result))
      );
      stream.end(req.file.buffer);
    });
    const attachmentType = isAudio ? 'audio' : isVideo ? 'video' : 'image';
    res.json({ url: result.secure_url, attachmentType });
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
    const { rows: countRows } = await pool.query('SELECT COUNT(*) FROM users');
    const isFirstUser = parseInt(countRows[0].count, 10) === 0;
    const { rows } = await pool.query(
      'INSERT INTO users (username, password_hash, is_admin) VALUES ($1, $2, $3) RETURNING id, username, is_admin',
      [username, hash, isFirstUser]
    );
    const token = signToken(rows[0]);
    res.json({ token, username: rows[0].username, isAdmin: rows[0].is_admin });
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
    res.json({ token, username: rows[0].username, isAdmin: rows[0].is_admin });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Something went wrong signing you in.' });
  }
});

// ---------- Members ----------
app.get('/api/users', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT username, created_at, is_admin, avatar_url FROM users ORDER BY created_at ASC'
  );
  res.json(rows);
});

app.post('/api/users/me/avatar', requireAuth, async (req, res) => {
  const { avatarUrl } = req.body || {};
  if (!avatarUrl) return res.status(400).json({ error: 'No image provided.' });
  try {
    await pool.query('UPDATE users SET avatar_url = $1 WHERE id = $2', [avatarUrl, req.user.id]);
    res.json({ success: true, avatarUrl });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not update your profile picture.' });
  }
});

app.post('/api/users/:username/reset-password', requireAuth, requireAdmin, async (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  }
  try {
    const hash = await hashPassword(newPassword);
    const { rowCount } = await pool.query(
      'UPDATE users SET password_hash = $1 WHERE username = $2',
      [hash, req.params.username]
    );
    if (!rowCount) return res.status(404).json({ error: 'No such user.' });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not reset password.' });
  }
});

// One-time recovery: promote your currently logged-in account to admin using a
// secret only you know (set ADMIN_BOOTSTRAP_SECRET in Render's Environment tab —
// remove it again once you've used it).
app.post('/api/admin/bootstrap', requireAuth, async (req, res) => {
  const { secret } = req.body || {};
  const expected = process.env.ADMIN_BOOTSTRAP_SECRET;
  if (!expected) return res.status(503).json({ error: 'No recovery secret is set up.' });
  if (secret !== expected) return res.status(403).json({ error: 'Incorrect secret.' });
  try {
    await pool.query('UPDATE users SET is_admin = true WHERE username = $1', [req.user.username]);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not update admin status.' });
  }
});

// ---------- Live/Status posts (disappear after 24 hours) ----------
app.get('/api/posts', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.username, u.avatar_url, p.text, p.media_url, p.media_type, p.created_at, p.expires_at,
              EXISTS(SELECT 1 FROM post_views v WHERE v.post_id = p.id AND v.user_id = $1) AS viewed_by_me,
              (SELECT reaction FROM post_reactions WHERE post_id = p.id AND user_id = $1) AS my_reaction,
              (SELECT COUNT(*)::int FROM post_reactions WHERE post_id = p.id AND reaction = 'like') AS like_count,
              (SELECT COUNT(*)::int FROM post_reactions WHERE post_id = p.id AND reaction = 'dislike') AS dislike_count,
              (SELECT COUNT(*)::int FROM post_reactions WHERE post_id = p.id AND reaction = 'hate') AS hate_count
       FROM posts p
       JOIN users u ON u.id = p.user_id
       WHERE p.expires_at > now()
       ORDER BY p.created_at ASC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load updates.' });
  }
});

app.post('/api/posts', requireAuth, async (req, res) => {
  const { text, mediaUrl, mediaType } = req.body || {};
  const cleanText = (text || '').trim();
  if (!cleanText && !mediaUrl) return res.status(400).json({ error: 'Add some text or a photo first.' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO posts (user_id, username, text, media_url, media_type, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '24 hours')
       RETURNING id, username, text, media_url, media_type, created_at, expires_at`,
      [req.user.id, req.user.username, cleanText || null, mediaUrl || null, mediaType || null]
    );
    const { rows: userRows } = await pool.query('SELECT avatar_url FROM users WHERE id = $1', [req.user.id]);
    const post = {
      ...rows[0],
      avatar_url: userRows[0]?.avatar_url || null,
      viewed_by_me: true,
      my_reaction: null,
      like_count: 0,
      dislike_count: 0,
      hate_count: 0,
    };
    io.emit('new_post', post);
    res.json(post);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not share that.' });
  }
});

app.post('/api/posts/:id/view', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'INSERT INTO post_views (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not update.' });
  }
});

const VALID_REACTIONS = ['like', 'dislike', 'hate'];

async function emitReactionCounts(postId) {
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM post_reactions WHERE post_id = $1 AND reaction = 'like') AS like_count,
       (SELECT COUNT(*)::int FROM post_reactions WHERE post_id = $1 AND reaction = 'dislike') AS dislike_count,
       (SELECT COUNT(*)::int FROM post_reactions WHERE post_id = $1 AND reaction = 'hate') AS hate_count`,
    [postId]
  );
  io.emit('post_reaction', { postId: Number(postId), ...rows[0] });
}

app.post('/api/posts/:id/react', requireAuth, async (req, res) => {
  const { reaction } = req.body || {};
  try {
    if (!reaction) {
      await pool.query('DELETE FROM post_reactions WHERE post_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
      await emitReactionCounts(req.params.id);
      return res.json({ success: true, reaction: null });
    }
    if (!VALID_REACTIONS.includes(reaction)) return res.status(400).json({ error: 'Invalid reaction.' });
    await pool.query(
      `INSERT INTO post_reactions (post_id, user_id, username, reaction) VALUES ($1, $2, $3, $4)
       ON CONFLICT (post_id, user_id) DO UPDATE SET reaction = EXCLUDED.reaction, created_at = now()`,
      [req.params.id, req.user.id, req.user.username, reaction]
    );
    await emitReactionCounts(req.params.id);
    res.json({ success: true, reaction });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not save your reaction.' });
  }
});

app.get('/api/posts/:id/viewers', requireAuth, async (req, res) => {
  try {
    const postRes = await pool.query('SELECT user_id FROM posts WHERE id = $1', [req.params.id]);
    if (!postRes.rows.length) return res.status(404).json({ error: 'Not found.' });
    if (postRes.rows[0].user_id !== req.user.id) {
      return res.status(403).json({ error: 'Only the person who posted this can see who viewed it.' });
    }
    const { rows } = await pool.query(
      `SELECT u.username, v.viewed_at, pr.reaction FROM post_views v
       JOIN users u ON u.id = v.user_id
       LEFT JOIN post_reactions pr ON pr.post_id = v.post_id AND pr.user_id = v.user_id
       WHERE v.post_id = $1 ORDER BY v.viewed_at ASC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load viewers.' });
  }
});

// Clear out expired posts once an hour so the table doesn't grow forever
setInterval(() => {
  pool.query('DELETE FROM posts WHERE expires_at < now()').catch(() => {});
}, 60 * 60 * 1000);

// ---------- Rooms ----------
app.get('/api/rooms', requireAuth, async (req, res) => {
  // A room shows up if it's a public group room (no room_members rows at all)
  // OR the current user is specifically a member of it (private DMs).
  const { rows } = await pool.query(
    `SELECT r.id, r.name, dm.other_username AS dm_with
     FROM rooms r
     LEFT JOIN (
       SELECT rm1.room_id, u.username AS other_username
       FROM room_members rm1
       JOIN room_members rm2 ON rm1.room_id = rm2.room_id AND rm2.user_id != rm1.user_id
       JOIN users u ON u.id = rm2.user_id
       WHERE rm1.user_id = $1
     ) dm ON dm.room_id = r.id
     WHERE NOT EXISTS (SELECT 1 FROM room_members WHERE room_id = r.id)
        OR EXISTS (SELECT 1 FROM room_members WHERE room_id = r.id AND user_id = $1)
     ORDER BY r.id ASC`,
    [req.user.id]
  );
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

// Find-or-create a private 1-to-1 chat with another user
app.post('/api/dm/:username', requireAuth, async (req, res) => {
  const targetUsername = req.params.username;
  if (targetUsername === req.user.username) {
    return res.status(400).json({ error: "You can't message yourself." });
  }
  try {
    const { rows: targetRows } = await pool.query('SELECT id, username FROM users WHERE username = $1', [targetUsername]);
    if (!targetRows.length) return res.status(404).json({ error: 'No such user.' });
    const targetId = targetRows[0].id;
    const [idA, idB] = [req.user.id, targetId].sort((a, b) => a - b);
    const roomName = `dm-${idA}-${idB}`;

    let { rows: existing } = await pool.query('SELECT id, name FROM rooms WHERE name = $1', [roomName]);
    let room;
    if (existing.length) {
      room = existing[0];
    } else {
      const { rows: created } = await pool.query('INSERT INTO rooms (name) VALUES ($1) RETURNING id, name', [roomName]);
      room = created[0];
      await pool.query(
        'INSERT INTO room_members (room_id, user_id) VALUES ($1, $2), ($1, $3) ON CONFLICT DO NOTHING',
        [room.id, req.user.id, targetId]
      );
    }
    res.json({ id: room.id, name: room.name, dm_with: targetUsername });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not start that conversation.' });
  }
});

async function userCanAccessRoom(roomId, userId) {
  const { rows } = await pool.query('SELECT 1 FROM room_members WHERE room_id = $1', [roomId]);
  if (!rows.length) return true; // public room, no membership restriction
  const { rows: memberRows } = await pool.query(
    'SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2',
    [roomId, userId]
  );
  return memberRows.length > 0;
}

app.get('/api/rooms/:id/messages', requireAuth, async (req, res) => {
  const allowed = await userCanAccessRoom(req.params.id, req.user.id);
  if (!allowed) return res.status(403).json({ error: 'You do not have access to this conversation.' });
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

  socket.on('join_room', async (roomId) => {
    const allowed = await userCanAccessRoom(roomId, socket.user.id);
    if (!allowed) return;
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
    const allowed = await userCanAccessRoom(roomId, socket.user.id);
    if (!allowed) return;
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
