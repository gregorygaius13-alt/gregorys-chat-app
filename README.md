# Gregory's — a private family chat app

A real, deployable chat app: password accounts, a Postgres database, and
live messaging over WebSockets. One backend (Express + Socket.io) serves
the built React frontend, so it's a single service to deploy.

## New: presence, typing indicators, read receipts, push notifications

- **Online status** — the sidebar shows who else is currently signed in.
- **Typing indicator** — "Name is typing…" appears while someone types in the room you're viewing.
- **Read receipts** — "Seen by …" appears under your last message once someone else has read up to it.
- **Push notifications** — a real phone-style notification appears even if the tab/app is closed, using free Web Push (no third-party account needed — just a one-time key pair you generate yourself).

### One extra setup step for push notifications: VAPID keys

Push notifications need a "VAPID key pair" — two random keys that prove your server owns the notifications it sends. A pair has already been generated for you below — just paste them in, no need to run anything yourself:

```
VAPID_PUBLIC_KEY=BBwvu-f6bmTbyK-RgJXHG3d4R0kjcaWeY9W3dh-FD377Hgu7fEfMHNckJeOXE855Y5vh7v_fkEW9xa9SFfBVWMw
VAPID_PRIVATE_KEY=pZzLsCrSpxXr778Fx4gWt-oHoVcYmfUOk30IqrFKKz0
```

1. When you create the Render Blueprint (step 3 below), Render will prompt you to fill in `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` — paste the two values above into those two boxes.
2. Treat the private key like a password — don't share it publicly (e.g. don't post it in a public GitHub repo's README or commit history). It's fine to paste only into Render's environment variable fields.
3. If you skip this, the app still works fine — it just won't send push notifications until you add the keys later (as environment variables in the Render dashboard, under your service's **Environment** tab).

## New: photo and voice-note sharing

- Tap **📎** next to the message box to send a photo.
- Tap **🎤** to record a voice note, tap **■** to stop and send it.
- Files are stored on **Cloudinary** (a free file-hosting service), since Render's free tier doesn't keep uploaded files permanently.

### One extra setup step for photo/voice sharing: Cloudinary keys

Your Cloudinary account details (already created — keep them private, don't post them publicly):

```
CLOUDINARY_CLOUD_NAME=z4ze0clq
CLOUDINARY_API_KEY=351484856433661
CLOUDINARY_API_SECRET=R1za9pTJJff-6CfNNYQEmaLFngI
```

1. On your Render dashboard, open your **family-chat** web service → **Environment** tab.
2. Add three environment variables using the exact names and values above.
3. Render will automatically redeploy after saving. Once it's back up, photo and voice-note sharing will work.
4. Skip this and the app still works fine — attaching a photo or voice note will just show an error until these are added.
5. Cloudinary's free tier includes 25GB of storage and bandwidth per month — more than enough for a family chat.

## Deploy it for free on Render

1. **Put this code on GitHub.**
   - Create a new repo (e.g. `kitchen-table-chat`) and push this whole folder to it.
   - If you don't use git yet:
     ```bash
     cd family-chat-app
     git init
     git add .
     git commit -m "Initial commit"
     git branch -M main
     git remote add origin https://github.com/YOUR_USERNAME/kitchen-table-chat.git
     git push -u origin main
     ```

2. **Create a Render account** at https://render.com (free, no card required for free tier).

3. **New Blueprint deploy:**
   - Click **New +** → **Blueprint**.
   - Connect your GitHub repo.
   - Render reads `render.yaml` and sets up two things automatically:
     - A free **Postgres database** (`family-chat-db`)
     - A free **Web Service** (`family-chat`) with the database connection and a random `JWT_SECRET` wired in
   - Click **Apply** / **Create**.

4. **Wait for the first deploy** (a few minutes — it installs both client and server, builds the React app, then starts the server).

5. Once live, Render gives you a URL like `https://family-chat.onrender.com`.
   Share that link with your family. Everyone creates their own username + password.

### Notes on the free tier
- The free Postgres database expires after 90 days unless you upgrade it — you'll get an email warning beforehand. Your family's message history depends on this database, so plan to upgrade (a few dollars/month) if you want it to last.
- Free web services "spin down" after 15 minutes of no traffic and take ~30–60 seconds to wake back up on the next visit. That's normal for free hosting, not a bug.

## Running it locally (optional, for testing before you deploy)

You'll need Node.js 18+ and a Postgres database (or use a free one from Render/Supabase and point `DATABASE_URL` at it).

```bash
# Terminal 1 — backend
cd server
npm install
DATABASE_URL="postgres://user:pass@localhost:5432/kitchentable" JWT_SECRET="dev-secret" npm start

# Terminal 2 — frontend (dev mode with hot reload)
cd client
npm install
npm run dev
```

Visit the URL Vite prints (usually `http://localhost:5173`).

## How it works
- **server/** — Express API (signup/login with hashed passwords + JWT, rooms, message history) and Socket.io for real-time delivery. Also serves the built frontend.
- **client/** — React app (Vite). Login/signup screen, then a WhatsApp-style room list + chat view. Connects over Socket.io once logged in.
- **Database** — five tables: `users`, `rooms`, `messages`, `room_reads` (read receipts), `push_subscriptions` (devices to notify). A `Family Group` room is created automatically the first time the server starts.

## Fair warning
This is a real app now — passwords are hashed properly, but there's no email verification, password reset, or rate limiting. That's fine for a small trusted family group, but don't reuse a sensitive password here, and don't expose it beyond people you trust.
