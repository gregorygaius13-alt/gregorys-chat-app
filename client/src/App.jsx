import React, { useState, useEffect, useRef, useCallback } from "react";
import { io } from "socket.io-client";
import { api, getToken, getUsername, getIsAdmin, setSession, clearSession } from "./api";

const COLORS = {
  ink: "#1B2A2F",
  inkSoft: "#24363C",
  paper: "#FBF7F1",
  rose: "#E0785F",
  roseDark: "#C4623F",
  sage: "#7A9E85",
  mist: "#E4E1D8",
  charcoal: "#2B2B28",
  cream: "#F4EFE6",
};

const AVATAR_PALETTE = ["#E0785F", "#7A9E85", "#C4623F", "#5D7A8C", "#B08968", "#8C7A9E"];

function hashColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length];
}
function initials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("");
}
function Avatar({ username, avatarUrl, size = 28, fontSize = 11 }) {
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt={username}
        style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }}
      />
    );
  }
  return (
    <div
      style={{
        width: size, height: size, borderRadius: "50%", background: hashColor(username),
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize, fontWeight: 600, color: "#fff", flexShrink: 0,
      }}
    >
      {initials(username)}
    </div>
  );
}
function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

function formatDay(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yest = new Date();
  yest.setDate(today.getDate() - 1);
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  if (sameDay(d, today)) return "Today";
  if (sameDay(d, yest)) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

export default function App() {
  const [session, setSess] = useState(() => {
    const token = getToken();
    const username = getUsername();
    return token && username ? { token, username, isAdmin: getIsAdmin() } : null;
  });

  if (!session) return <AuthScreen onAuthed={(s) => setSess(s)} />;
  return <ChatApp session={session} onLogout={() => { clearSession(); setSess(null); }} />;
}

// ============================ AUTH SCREEN ============================
function AuthScreen({ onAuthed }) {
  const [mode, setMode] = useState("login"); // 'login' | 'signup'
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError("");
    if (!username.trim() || !password) return;
    setBusy(true);
    try {
      const fn = mode === "login" ? api.login : api.signup;
      const data = await fn(username.trim(), password);
      setSession(data.token, data.username, data.isAdmin);
      onAuthed({ token: data.token, username: data.username, isAdmin: data.isAdmin });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={styles.joinWrap}>
      <GlobalStyle />
      <div style={styles.joinCard}>
        <div style={styles.joinStamp}><i className="fa-solid fa-comments" style={{ color: "#fff", fontSize: 20 }}></i></div>
        <h1 style={styles.joinTitle}>Gregory's</h1>
        <p style={styles.joinSub}>
          A private space for the people who matter most.
        </p>

        <div style={styles.tabRow}>
          <button
            onClick={() => { setMode("login"); setError(""); }}
            style={{ ...styles.tabBtn, ...(mode === "login" ? styles.tabBtnActive : {}) }}
          >
            Log in
          </button>
          <button
            onClick={() => { setMode("signup"); setError(""); }}
            style={{ ...styles.tabBtn, ...(mode === "signup" ? styles.tabBtnActive : {}) }}
          >
            Create account
          </button>
        </div>

        <form onSubmit={submit} style={{ width: "100%" }}>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Username"
            style={styles.joinInput}
            maxLength={30}
            autoCapitalize="none"
          />
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            type="password"
            style={styles.joinInput}
          />
          {error && <div style={styles.errText}>{error}</div>}
          <button type="submit" style={styles.joinBtn} disabled={busy || !username.trim() || !password}>
            {busy ? "Please wait…" : mode === "login" ? "Log in" : "Create account"}
          </button>
        </form>
        {mode === "signup" && (
          <p style={styles.joinNote}>Passwords need at least 6 characters.</p>
        )}
      </div>
    </div>
  );
}

// ============================ CHAT APP ============================
function ChatApp({ session, onLogout }) {
  const { token, username, isAdmin } = session;
  const [rooms, setRooms] = useState([]);
  const [activeRoom, setActiveRoom] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [showNewRoom, setShowNewRoom] = useState(false);
  const [newRoomInput, setNewRoomInput] = useState("");
  const [showMobileList, setShowMobileList] = useState(true);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [connError, setConnError] = useState(false);
  const [onlineUsers, setOnlineUsers] = useState([]);
  const [typingUser, setTypingUser] = useState(null);
  const [readReceipts, setReadReceipts] = useState({}); // { [roomId]: { [username]: lastReadMessageId } }
  const [showMembers, setShowMembers] = useState(false);
  const [members, setMembers] = useState([]);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [profileUploading, setProfileUploading] = useState(false);
  const profilePhotoInputRef = useRef(null);

  const avatarMap = Object.fromEntries(members.map((m) => [m.username, m.avatar_url]));

  useEffect(() => {
    api.getUsers().then(setMembers).catch(() => {});
  }, []);

  async function handleProfilePhotoChange(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setProfileUploading(true);
    try {
      const { url } = await api.uploadFile(file);
      await api.updateAvatar(url);
      setMembers((prev) => prev.map((m) => (m.username === username ? { ...m, avatar_url: url } : m)));
    } catch (err) {
      alert(err.message);
    }
    setProfileUploading(false);
  }

  async function handleStartDM(targetUsername) {
    try {
      const room = await api.startDirectMessage(targetUsername);
      setRooms((prev) => (prev.some((r) => r.id === room.id) ? prev : [...prev, room]));
      setActiveRoom(room);
      setShowMembers(false);
      setShowMobileList(false);
    } catch (err) {
      alert(err.message);
    }
  }

  async function handleResetPassword(targetUsername) {
    const newPassword = window.prompt(`New password for ${targetUsername} (at least 6 characters):`);
    if (!newPassword) return;
    try {
      await api.resetPassword(targetUsername, newPassword);
      alert(`Password reset for ${targetUsername}. Tell them their new password directly.`);
    } catch (err) {
      alert(err.message);
    }
  }

  async function handleRecoverAdmin() {
    const secret = window.prompt("Enter the recovery secret (set as ADMIN_BOOTSTRAP_SECRET on Render):");
    if (!secret) return;
    try {
      await api.bootstrapAdmin(secret);
      alert("You're now an admin! Log out and log back in for it to take effect.");
    } catch (err) {
      alert(err.message);
    }
  }

  async function openMembers() {
    setShowMembers(true);
    setLoadingMembers(true);
    try {
      const list = await api.getUsers();
      setMembers(list);
    } catch {}
    setLoadingMembers(false);
  }

  const socketRef = useRef(null);
  const scrollRef = useRef(null);
  const activeRoomRef = useRef(null);
  const typingTimeoutRef = useRef(null);

  // ---- socket lifecycle ----
  useEffect(() => {
    const socket = io(window.location.origin, { auth: { token } });
    socketRef.current = socket;

    socket.on("connect_error", () => setConnError(true));
    socket.on("connect", () => setConnError(false));

    socket.on("new_message", ({ roomId, message }) => {
      if (roomId === activeRoomRef.current) {
        setMessages((prev) => [...prev, message]);
        socket.emit("mark_read", { roomId, messageId: message.id });
      }
    });

    socket.on("presence", (names) => setOnlineUsers(names));

    socket.on("typing", ({ roomId, username: who }) => {
      if (roomId !== activeRoomRef.current || who === username) return;
      setTypingUser(who);
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = setTimeout(() => setTypingUser(null), 3000);
    });

    socket.on("read_update", ({ roomId, username: who, messageId }) => {
      setReadReceipts((prev) => ({
        ...prev,
        [roomId]: { ...(prev[roomId] || {}), [who]: messageId },
      }));
    });

    return () => socket.disconnect();
  }, [token, username]);

  // ---- push notifications: register service worker + subscribe (best-effort) ----
  useEffect(() => {
    async function setupPush() {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
      try {
        const { publicKey } = await api.getPushPublicKey();
        if (!publicKey) return; // server has no VAPID keys configured yet
        const registration = await navigator.serviceWorker.register("/sw.js");
        const permission = await Notification.requestPermission();
        if (permission !== "granted") return;
        let subscription = await registration.pushManager.getSubscription();
        if (!subscription) {
          subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicKey),
          });
        }
        await api.subscribePush(subscription.toJSON());
      } catch {
        // Push notifications are a nice-to-have; failures here shouldn't break the app.
      }
    }
    setupPush();
  }, []);

  // ---- load rooms on mount ----
  useEffect(() => {
    api.getRooms().then(setRooms).catch(() => {});
  }, []);

  useEffect(() => {
    if (!activeRoom && rooms.length) setActiveRoom(rooms[0]);
  }, [rooms, activeRoom]);

  // ---- switch room ----
  useEffect(() => {
    activeRoomRef.current = activeRoom?.id ?? null;
    setTypingUser(null);
    if (!activeRoom) return;
    setLoadingMsgs(true);
    api
      .getMessages(activeRoom.id)
      .then((msgs) => {
        setMessages(msgs);
        const last = msgs[msgs.length - 1];
        if (last) socketRef.current?.emit("mark_read", { roomId: activeRoom.id, messageId: last.id });
      })
      .finally(() => setLoadingMsgs(false));
    socketRef.current?.emit("join_room", activeRoom.id);
  }, [activeRoom]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const [uploading, setUploading] = useState(false);
  const [recording, setRecording] = useState(false);
  const fileInputRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);

  const sendMessage = useCallback(
    (e) => {
      e.preventDefault();
      const text = draft.trim();
      if (!text || !activeRoom) return;
      socketRef.current?.emit("send_message", { roomId: activeRoom.id, text });
      setDraft("");
    },
    [draft, activeRoom]
  );

  async function handlePickPhoto(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !activeRoom) return;
    setUploading(true);
    try {
      const { url, attachmentType } = await api.uploadFile(file);
      socketRef.current?.emit("send_message", { roomId: activeRoom.id, text: "", attachmentUrl: url, attachmentType });
    } catch (err) {
      alert(err.message);
    }
    setUploading(false);
  }

  async function toggleVoiceRecording() {
    if (!activeRoom) return;
    if (recording) {
      mediaRecorderRef.current?.stop();
      setRecording(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => audioChunksRef.current.push(e.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        const file = new File([blob], "voice-note.webm", { type: "audio/webm" });
        setUploading(true);
        try {
          const { url } = await api.uploadFile(file);
          socketRef.current?.emit("send_message", { roomId: activeRoom.id, text: "", attachmentUrl: url, attachmentType: "audio" });
        } catch (err) {
          alert(err.message);
        }
        setUploading(false);
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch {
      alert("Couldn't access your microphone. Check your browser's permission settings.");
    }
  }

  const lastTypingEmitRef = useRef(0);
  function handleDraftChange(e) {
    setDraft(e.target.value);
    if (!activeRoom) return;
    const now = Date.now();
    if (now - lastTypingEmitRef.current > 1500) {
      lastTypingEmitRef.current = now;
      socketRef.current?.emit("typing", { roomId: activeRoom.id });
    }
  }

  async function createRoom(e) {
    e.preventDefault();
    const name = newRoomInput.trim();
    if (!name) return;
    try {
      const room = await api.createRoom(name);
      setRooms((prev) => (prev.some((r) => r.id === room.id) ? prev : [...prev, room]));
      setActiveRoom(room);
      setShowNewRoom(false);
      setNewRoomInput("");
      setShowMobileList(false);
    } catch {}
  }

  function selectRoom(room) {
    setActiveRoom(room);
    setShowMobileList(false);
  }

  const grouped = [];
  let lastDay = null;
  for (const m of messages) {
    const day = formatDay(m.created_at);
    if (day !== lastDay) {
      grouped.push({ divider: day, key: `div-${m.id}` });
      lastDay = day;
    }
    grouped.push(m);
  }

  const myMessages = messages.filter((m) => m.username === username);
  const myLastMessageId = myMessages.length ? myMessages[myMessages.length - 1].id : null;
  const roomReceipts = (activeRoom && readReceipts[activeRoom.id]) || {};
  const seenByNames = Object.entries(roomReceipts)
    .filter(([who, lastId]) => who !== username && myLastMessageId && lastId >= myLastMessageId)
    .map(([who]) => who);

  return (
    <div style={styles.appWrap}>
      <GlobalStyle />
      <div style={{ ...styles.sidebar, display: showMobileList ? "flex" : "none" }} className="fc-sidebar">
        <div style={styles.sidebarHeader}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button onClick={() => setShowProfile(true)} style={styles.avatarBtn} title="Edit your profile picture">
              <Avatar username={username} avatarUrl={avatarMap[username]} size={38} fontSize={13} />
            </button>
            <div>
              <div style={styles.sidebarBrand}>Gregory's</div>
              <div style={styles.sidebarUser}>signed in as {username}</div>
              {onlineUsers.filter((u) => u !== username).length > 0 && (
                <div style={styles.onlineBadge}>
                  <span style={styles.onlineDot} /> {onlineUsers.filter((u) => u !== username).join(", ")} online
                </div>
              )}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={openMembers} style={styles.membersBtn}>Members</button>
            <button onClick={onLogout} style={styles.logoutBtn}>Log out</button>
          </div>
        </div>

        <div style={styles.roomListWrap}>
          {rooms.map((r) => (
            <button
              key={r.id}
              onClick={() => selectRoom(r)}
              style={{ ...styles.roomItem, background: activeRoom?.id === r.id ? COLORS.inkSoft : "transparent" }}
            >
              {r.dm_with ? (
                <Avatar username={r.dm_with} avatarUrl={avatarMap[r.dm_with]} size={34} fontSize={13} />
              ) : (
                <div style={{ ...styles.roomAvatar, background: hashColor(r.name) }}><i className="fa-solid fa-users" style={{ color: "#fff", fontSize: 13 }}></i></div>
              )}
              <span style={styles.roomName}>{r.dm_with || r.name}</span>
            </button>
          ))}
        </div>

        <div style={styles.newRoomWrap}>
          {showNewRoom ? (
            <form onSubmit={createRoom} style={{ display: "flex", gap: 6 }}>
              <input
                autoFocus
                value={newRoomInput}
                onChange={(e) => setNewRoomInput(e.target.value)}
                placeholder="Room name…"
                style={styles.newRoomInput}
                maxLength={30}
              />
              <button type="submit" style={styles.newRoomGo}><i className="fa-solid fa-plus"></i></button>
            </form>
          ) : (
            <button onClick={() => setShowNewRoom(true)} style={styles.newRoomBtn}><i className="fa-solid fa-plus"></i>&nbsp; New room</button>
          )}
        </div>
      </div>

      <div style={{ ...styles.chatPane, display: showMobileList ? "none" : "flex" }} className="fc-chatpane">
        {activeRoom ? (
          <>
            <div style={styles.chatHeader}>
              <button className="fc-back" onClick={() => setShowMobileList(true)} style={styles.backBtn}><i className="fa-solid fa-arrow-left"></i></button>
              {activeRoom.dm_with ? (
                <Avatar username={activeRoom.dm_with} avatarUrl={avatarMap[activeRoom.dm_with]} size={34} fontSize={13} />
              ) : (
                <div style={{ ...styles.roomAvatar, background: hashColor(activeRoom.name) }}><i className="fa-solid fa-users" style={{ color: "#fff", fontSize: 13 }}></i></div>
              )}
              <div style={styles.chatHeaderTitle}>{activeRoom.dm_with || activeRoom.name}</div>
            </div>

            <div ref={scrollRef} style={styles.messagesWrap}>
              {loadingMsgs ? (
                <div style={styles.emptyState}>Fetching messages…</div>
              ) : messages.length === 0 ? (
                <div style={styles.emptyState}>No messages yet — say the first hello.</div>
              ) : (
                grouped.map((item) =>
                  item.divider ? (
                    <div key={item.key} style={styles.dayDividerWrap}>
                      <div style={styles.postmark}>{item.divider}</div>
                    </div>
                  ) : (
                    <div
                      key={item.id}
                      style={{ ...styles.bubbleRow, justifyContent: item.username === username ? "flex-end" : "flex-start" }}
                    >
                      {item.username !== username && (
                        <Avatar username={item.username} avatarUrl={avatarMap[item.username]} size={28} fontSize={11} />
                      )}
                      <div>
                        {item.username !== username && <div style={styles.senderLabel}>{item.username}</div>}
                        <div
                          style={{
                            ...styles.bubble,
                            background: item.username === username ? COLORS.rose : "#fff",
                            color: item.username === username ? "#fff" : COLORS.charcoal,
                            borderTopRightRadius: item.username === username ? 4 : 16,
                            borderTopLeftRadius: item.username === username ? 16 : 4,
                          }}
                        >
                          {item.attachment_type === "image" && (
                            <img
                              src={item.attachment_url}
                              alt="shared"
                              style={styles.attachmentImage}
                              onClick={() => window.open(item.attachment_url, "_blank")}
                            />
                          )}
                          {item.attachment_type === "audio" && (
                            <audio controls src={item.attachment_url} style={styles.attachmentAudio} />
                          )}
                          {item.text}
                          <span
                            style={{
                              ...styles.bubbleTime,
                              color: item.username === username ? "rgba(255,255,255,0.75)" : "#8a8a83",
                            }}
                          >
                            {formatTime(item.created_at)}
                          </span>
                        </div>
                        {item.username === username && item.id === myLastMessageId && seenByNames.length > 0 && (
                          <div style={styles.seenLabel}>Seen by {seenByNames.join(", ")}</div>
                        )}
                      </div>
                    </div>
                  )
                )
              )}
            </div>

            {typingUser && <div style={styles.typingIndicator}>{typingUser} is typing…</div>}
            {uploading && <div style={styles.typingIndicator}>Uploading…</div>}

            <form onSubmit={sendMessage} style={styles.inputBar}>
              <input
                type="file"
                accept="image/*"
                ref={fileInputRef}
                onChange={handlePickPhoto}
                style={{ display: "none" }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                style={styles.iconBtn}
                disabled={uploading}
                title="Attach a photo"
              >
                <i className="fa-solid fa-paperclip"></i>
              </button>
              <button
                type="button"
                onClick={toggleVoiceRecording}
                style={{ ...styles.iconBtn, background: recording ? COLORS.roseDark : "transparent", color: recording ? "#fff" : COLORS.charcoal }}
                disabled={uploading}
                title={recording ? "Stop recording" : "Record a voice note"}
              >
                <i className={recording ? "fa-solid fa-stop" : "fa-solid fa-microphone"}></i>
              </button>
              <input
                value={draft}
                onChange={handleDraftChange}
                placeholder="Write something…"
                style={styles.textInput}
              />
              <button type="submit" style={styles.sendBtn} disabled={!draft.trim()}><i className="fa-solid fa-paper-plane"></i></button>
            </form>
            {connError && (
              <div style={styles.errBanner}>Connection lost — trying to reconnect…</div>
            )}
          </>
        ) : (
          <div style={styles.emptyState}>Pick a room to start chatting.</div>
        )}
      </div>

      {showMembers && (
        <div style={styles.modalOverlay} onClick={() => setShowMembers(false)}>
          <div style={styles.modalCard} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <div style={styles.modalTitle}>Who's signed up</div>
              <button onClick={() => setShowMembers(false)} style={styles.modalClose}><i className="fa-solid fa-xmark"></i></button>
            </div>
            {loadingMembers ? (
              <div style={styles.emptyState}>Loading…</div>
            ) : members.length === 0 ? (
              <div style={styles.emptyState}>No members yet.</div>
            ) : (
              <div style={styles.membersList}>
                {members.map((m) => (
                  <div key={m.username} style={styles.memberRow}>
                    <Avatar username={m.username} avatarUrl={m.avatar_url} size={38} fontSize={13} />
                    <div style={{ flex: 1 }}>
                      <div style={styles.memberName}>
                        {m.username}
                        {onlineUsers.includes(m.username) && <span style={styles.onlineDotInline} />}
                        {m.is_admin && <span style={styles.adminTag}>admin</span>}
                      </div>
                      <div style={styles.memberJoined}>
                        Joined {new Date(m.created_at).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}
                      </div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
                      {m.username !== username && (
                        <button onClick={() => handleStartDM(m.username)} style={styles.dmBtn}>
                          <i className="fa-solid fa-message"></i>&nbsp; Message
                        </button>
                      )}
                      {isAdmin && (
                        <button onClick={() => handleResetPassword(m.username)} style={styles.resetBtn}>
                          Reset password
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {!isAdmin && (
              <div style={styles.recoverLinkWrap}>
                <button onClick={handleRecoverAdmin} style={styles.recoverLink}>
                  Locked out of the original admin account? Recover access
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {showProfile && (
        <div style={styles.modalOverlay} onClick={() => setShowProfile(false)}>
          <div style={{ ...styles.modalCard, maxWidth: 320 }} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <div style={styles.modalTitle}>Your profile</div>
              <button onClick={() => setShowProfile(false)} style={styles.modalClose}><i className="fa-solid fa-xmark"></i></button>
            </div>
            <div style={styles.profileBody}>
              <Avatar username={username} avatarUrl={avatarMap[username]} size={88} fontSize={28} />
              <div style={styles.profileName}>{username}</div>
              <input
                type="file"
                accept="image/*"
                ref={profilePhotoInputRef}
                onChange={handleProfilePhotoChange}
                style={{ display: "none" }}
              />
              <button
                onClick={() => profilePhotoInputRef.current?.click()}
                style={styles.profileUploadBtn}
                disabled={profileUploading}
              >
                <i className="fa-solid fa-camera"></i>&nbsp; {profileUploading ? "Uploading…" : avatarMap[username] ? "Change photo" : "Add a photo"}
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @media (min-width: 760px) {
          .fc-sidebar { display: flex !important; }
          .fc-chatpane { display: flex !important; }
          .fc-back { display: none !important; }
        }
      `}</style>
    </div>
  );
}

function GlobalStyle() {
  return <style>{`* { box-sizing: border-box; } body { margin: 0; }`}</style>;
}

const styles = {
  joinWrap: {
    minHeight: "100vh", width: "100%",
    background: `linear-gradient(160deg, ${COLORS.ink} 0%, ${COLORS.inkSoft} 100%)`,
    display: "flex", alignItems: "center", justifyContent: "center",
    fontFamily: "'Inter', sans-serif", padding: 24,
  },
  joinCard: {
    background: COLORS.paper, borderRadius: 20, padding: "40px 32px",
    maxWidth: 380, width: "100%", textAlign: "center",
    boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
  },
  joinStamp: {
    width: 48, height: 48, borderRadius: "50%", background: COLORS.rose,
    display: "flex", alignItems: "center", justifyContent: "center",
    margin: "0 auto 18px", fontSize: 20,
  },
  joinTitle: { fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: 28, color: COLORS.charcoal, margin: "0 0 10px" },
  joinSub: { fontSize: 14, color: "#6b6b62", lineHeight: 1.5, margin: "0 0 22px" },
  tabRow: { display: "flex", background: COLORS.mist, borderRadius: 12, padding: 4, marginBottom: 18 },
  tabBtn: { flex: 1, padding: "9px 0", border: "none", background: "transparent", borderRadius: 9, fontSize: 13.5, fontWeight: 600, color: "#6b6b62", cursor: "pointer" },
  tabBtnActive: { background: "#fff", color: COLORS.charcoal, boxShadow: "0 1px 3px rgba(0,0,0,0.1)" },
  joinInput: {
    width: "100%", padding: "13px 16px", borderRadius: 12, border: `1.5px solid ${COLORS.mist}`,
    fontSize: 15, fontFamily: "'Inter', sans-serif", marginBottom: 12, outline: "none",
    color: COLORS.charcoal, background: "#fff",
  },
  joinBtn: {
    width: "100%", padding: "13px 16px", borderRadius: 12, border: "none",
    background: COLORS.rose, color: "#fff", fontSize: 15, fontWeight: 600,
    fontFamily: "'Inter', sans-serif", cursor: "pointer",
  },
  joinNote: { fontSize: 12, color: "#9a9a90", marginTop: 14 },
  errText: { color: COLORS.roseDark, fontSize: 13, marginBottom: 10, textAlign: "left" },
  appWrap: { display: "flex", height: "100vh", width: "100%", fontFamily: "'Inter', sans-serif", overflow: "hidden" },
  sidebar: { width: "100%", maxWidth: 340, background: COLORS.ink, flexDirection: "column", flexShrink: 0 },
  sidebarHeader: { padding: "22px 20px 16px", borderBottom: `1px solid rgba(255,255,255,0.08)`, display: "flex", justifyContent: "space-between", alignItems: "flex-start" },
  sidebarBrand: { fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: 19, color: COLORS.paper },
  sidebarUser: { fontSize: 12, color: "rgba(251,247,241,0.55)", marginTop: 4 },
  logoutBtn: { background: "transparent", border: `1px solid rgba(251,247,241,0.3)`, color: "rgba(251,247,241,0.8)", borderRadius: 8, fontSize: 11.5, padding: "5px 9px", cursor: "pointer" },
  membersBtn: { background: "transparent", border: `1px solid rgba(251,247,241,0.3)`, color: "rgba(251,247,241,0.8)", borderRadius: 8, fontSize: 11.5, padding: "5px 9px", cursor: "pointer" },
  modalOverlay: { position: "fixed", inset: 0, background: "rgba(27,42,47,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 20 },
  modalCard: { background: COLORS.paper, borderRadius: 18, width: "100%", maxWidth: 380, maxHeight: "70vh", overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,0.35)" },
  modalHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 18px", borderBottom: `1px solid ${COLORS.mist}` },
  modalTitle: { fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: 17, color: COLORS.charcoal },
  modalClose: { border: "none", background: "transparent", fontSize: 16, cursor: "pointer", color: "#9a9a90" },
  membersList: { overflowY: "auto", padding: "10px 8px" },
  memberRow: { display: "flex", alignItems: "center", gap: 12, padding: "10px 10px", borderRadius: 12 },
  memberName: { fontSize: 14.5, fontWeight: 600, color: COLORS.charcoal, display: "flex", alignItems: "center", gap: 6 },
  memberJoined: { fontSize: 12, color: "#9a9a90", marginTop: 2 },
  onlineDotInline: { width: 7, height: 7, borderRadius: "50%", background: COLORS.sage, display: "inline-block" },
  adminTag: { fontSize: 10, fontWeight: 700, color: COLORS.roseDark, background: "rgba(224,120,95,0.12)", padding: "2px 6px", borderRadius: 6, textTransform: "uppercase", letterSpacing: 0.3 },
  resetBtn: { fontSize: 11.5, padding: "6px 10px", borderRadius: 8, border: `1px solid ${COLORS.mist}`, background: "#fff", color: COLORS.charcoal, cursor: "pointer", whiteSpace: "nowrap" },
  recoverLinkWrap: { padding: "10px 18px 16px", borderTop: `1px solid ${COLORS.mist}` },
  recoverLink: { border: "none", background: "transparent", color: "#9a9a90", fontSize: 11.5, cursor: "pointer", textDecoration: "underline", padding: 0 },
  avatarBtn: { border: "none", background: "transparent", padding: 0, cursor: "pointer", borderRadius: "50%" },
  dmBtn: { fontSize: 11.5, padding: "6px 10px", borderRadius: 8, border: "none", background: COLORS.rose, color: "#fff", cursor: "pointer", whiteSpace: "nowrap" },
  profileBody: { display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "28px 20px" },
  profileName: { fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: 17, color: COLORS.charcoal },
  profileUploadBtn: { border: `1.5px solid ${COLORS.mist}`, background: "#fff", color: COLORS.charcoal, borderRadius: 10, padding: "10px 16px", fontSize: 13.5, cursor: "pointer", marginTop: 4 },
  onlineBadge: { display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "rgba(251,247,241,0.65)", marginTop: 6 },
  onlineDot: { width: 7, height: 7, borderRadius: "50%", background: COLORS.sage, display: "inline-block" },
  typingIndicator: { padding: "4px 20px", fontSize: 12, color: "#9a9a90", fontStyle: "italic" },
  seenLabel: { fontSize: 10.5, color: "#9a9a90", textAlign: "right", marginTop: 3, marginRight: 2 },
  roomListWrap: { flex: 1, overflowY: "auto", padding: "10px 10px" },
  roomItem: { width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", borderRadius: 12, border: "none", cursor: "pointer", marginBottom: 4, textAlign: "left" },
  roomAvatar: { width: 34, height: 34, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: 14 },
  roomName: { color: COLORS.paper, fontSize: 14.5, fontWeight: 500 },
  newRoomWrap: { padding: 14, borderTop: `1px solid rgba(255,255,255,0.08)` },
  newRoomBtn: { width: "100%", display: "flex", alignItems: "center", gap: 8, justifyContent: "center", padding: "10px", borderRadius: 10, border: `1px dashed rgba(251,247,241,0.35)`, background: "transparent", color: "rgba(251,247,241,0.8)", fontSize: 13.5, cursor: "pointer" },
  newRoomInput: { flex: 1, padding: "9px 12px", borderRadius: 8, border: "none", fontSize: 13.5, outline: "none" },
  newRoomGo: { border: "none", background: COLORS.paper, borderRadius: 8, padding: "0 14px", cursor: "pointer", fontWeight: 700 },
  chatPane: { flex: 1, flexDirection: "column", background: COLORS.paper, minWidth: 0 },
  chatHeader: { display: "flex", alignItems: "center", gap: 12, padding: "14px 20px", borderBottom: `1px solid ${COLORS.mist}`, background: "#fff" },
  backBtn: { border: "none", background: "transparent", cursor: "pointer", padding: 4, fontSize: 18 },
  chatHeaderTitle: { fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: 17, color: COLORS.charcoal },
  messagesWrap: { flex: 1, overflowY: "auto", padding: "22px 20px", display: "flex", flexDirection: "column", gap: 12 },
  dayDividerWrap: { display: "flex", justifyContent: "center", margin: "8px 0" },
  postmark: { border: `1.5px dashed ${COLORS.sage}`, borderRadius: "50%", width: 92, height: 92, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11.5, fontWeight: 600, color: COLORS.sage, textAlign: "center", padding: 8, lineHeight: 1.3, background: "rgba(122,158,133,0.06)" },
  bubbleRow: { display: "flex", gap: 8, alignItems: "flex-end" },
  msgAvatar: { width: 28, height: 28, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 600, color: "#fff", flexShrink: 0 },
  senderLabel: { fontSize: 11.5, color: "#9a9a90", marginBottom: 3, marginLeft: 4 },
  bubble: { maxWidth: 340, padding: "10px 14px", borderRadius: 16, fontSize: 14.5, lineHeight: 1.45, boxShadow: "0 1px 2px rgba(0,0,0,0.06)", wordBreak: "break-word" },
  bubbleTime: { display: "block", fontSize: 10.5, marginTop: 4, textAlign: "right" },
  emptyState: { margin: "auto", color: "#9a9a90", fontSize: 14 },
  inputBar: { display: "flex", gap: 10, padding: "14px 18px", borderTop: `1px solid ${COLORS.mist}`, background: "#fff" },
  textInput: { flex: 1, padding: "12px 16px", borderRadius: 24, border: `1.5px solid ${COLORS.mist}`, fontSize: 14.5, outline: "none", fontFamily: "'Inter', sans-serif" },
  sendBtn: { width: 44, height: 44, borderRadius: "50%", border: "none", background: COLORS.rose, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0, fontSize: 16 },
  iconBtn: { width: 40, height: 40, borderRadius: "50%", border: `1.5px solid ${COLORS.mist}`, background: "transparent", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0, fontSize: 16 },
  attachmentImage: { display: "block", maxWidth: 220, maxHeight: 220, borderRadius: 12, marginBottom: 6, cursor: "pointer", objectFit: "cover" },
  attachmentAudio: { display: "block", marginBottom: 6, maxWidth: 240 },
  errBanner: { textAlign: "center", fontSize: 12, color: COLORS.roseDark, padding: "6px 0", background: COLORS.cream },
};
