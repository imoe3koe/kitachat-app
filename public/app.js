let currentUser = null;
let socket = null;
let failedLoginAttempts = 0;
let isLoggingOut = false;
let socketBound = false;

const STORAGE_KEYS = {
  user: 'kitachat_user',
  token: 'kitachat_session_token',
  theme: 'kitachat_theme'
};

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ],
  iceCandidatePoolSize: 10
};

let localStream = null;
let peerConnection = null;
let targetSocketId = null;
let targetUserId = null;
let activeCallId = null;
let iceCandidateQueue = [];
let incomingOffer = null;
let acceptingCall = false;

const MAX_ICE_CANDIDATES = 64;
const MAX_PENDING_ICE_CALLS = 20;
const PENDING_ICE_TTL_MS = 30_000;
const pendingIceByCallId = new Map();

const chatBeepAudio = new Audio('/audio/chat-beep.mp3');
const callRingtone = new Audio('/audio/nadadering-phone.mp3');
callRingtone.loop = true;

window.replyingToMessageId = null;
let deferredPrompt = null;

// ==========================================================
// REGISTRATION FAMILY HELPER
// ==========================================================
function toggleInviteCodeInput(type) {
  const container = document.getElementById('invite-code-container');
  const inviteInput = document.getElementById('reg-invite-code');
  if (!container || !inviteInput) return;

  if (type === 'join') {
    container.classList.remove('hidden');
    inviteInput.required = true;
  } else {
    container.classList.add('hidden');
    inviteInput.required = false;
    inviteInput.value = '';
  }
}

// ==========================================================
// CALL HELPERS
// ==========================================================
function normalizeCallUserId(value) {
  return value == null ? '' : String(value);
}

function createCallId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `call-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isValidCallDescription(description, expectedType) {
  return Boolean(
    description &&
    description.type === expectedType &&
    typeof description.sdp === 'string'
  );
}

function setCallStatus(text) {
  const title = document.getElementById('call-status-title');
  if (title) title.innerText = text;
}

function queueIceCandidate(candidate) {
  if (!candidate || iceCandidateQueue.length >= MAX_ICE_CANDIDATES) {
    return;
  }
  iceCandidateQueue.push(candidate);
}

function rememberIceBeforeOffer(data) {
  const callId = String(data.callId || '');
  const fromUserId = normalizeCallUserId(data.fromUserId);

  if (!callId || !fromUserId || !data.candidate) return;

  let entry = pendingIceByCallId.get(callId);
  if (!entry || Date.now() - entry.createdAt > PENDING_ICE_TTL_MS) {
    entry = {
      fromUserId,
      candidates: [],
      createdAt: Date.now()
    };
    pendingIceByCallId.set(callId, entry);
  }

  if (entry.fromUserId !== fromUserId) return;
  if (entry.candidates.length >= MAX_ICE_CANDIDATES) return;

  entry.candidates.push(data.candidate);

  while (pendingIceByCallId.size > MAX_PENDING_ICE_CALLS) {
    const oldestCallId = pendingIceByCallId.keys().next().value;
    pendingIceByCallId.delete(oldestCallId);
  }
}

function sendCallSignal(type, toUserId, extraPayload = {}) {
  if (!currentUser?.id || !activeCallId || !socket || !socket.connected) {
    return false;
  }

  const payload = {
    ...extraPayload,
    callId: String(activeCallId),
    toUserId: normalizeCallUserId(toUserId)
  };

  if (!payload.toUserId) return false;

  let eventName = '';
  if (type === 'offer') eventName = 'call_user';
  else if (type === 'answer') eventName = 'call_answer'; 
  else if (type === 'ice_candidate') eventName = 'call_ice_candidate';
  else if (type === 'end_call') eventName = 'end_call';

  if (!eventName) return false;

  try {
    socket.emit(eventName, payload);
    return true;
  } catch (error) {
    console.error(`Gagal mengirim sinyal ${type} via Socket.IO:`, error);
    return false;
  }
}

async function drainIceCandidateQueue(expectedCallId, connection) {
  if (
    !connection ||
    activeCallId !== expectedCallId ||
    !connection.remoteDescription
  ) {
    return;
  }

  while (
    iceCandidateQueue.length > 0 &&
    activeCallId === expectedCallId &&
    peerConnection === connection
  ) {
    const candidate = iceCandidateQueue.shift();
    try {
      await connection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (error) {
      console.warn('Gagal menambahkan kandidat ICE:', error);
    }
  }
}

// ==========================================================
// SESSION / STORAGE
// ==========================================================
function clearSavedSession() {
  localStorage.removeItem(STORAGE_KEYS.user);
  localStorage.removeItem(STORAGE_KEYS.token);
}

function loadSavedSession() {
  const savedUser = localStorage.getItem(STORAGE_KEYS.user);
  const savedToken = localStorage.getItem(STORAGE_KEYS.token);

  if (!savedUser || !savedToken || savedUser === 'undefined') {
    return null;
  }

  try {
    const parsed = JSON.parse(savedUser);
    if (!parsed || !parsed.id) {
      throw new Error('User tidak valid');
    }
    return {
      user: parsed,
      token: savedToken
    };
  } catch (error) {
    console.warn('Sesi tersimpan tidak valid:', error);
    clearSavedSession();
    return null;
  }
}

function getSavedSession() {
  const saved = loadSavedSession();
  return saved || { user: null, token: null };
}

const savedSession = getSavedSession();
if (savedSession.user) {
  currentUser = savedSession.user;
}

// ==========================================================
// SOCKET.IO & SIGNALING LISTENERS
// ==========================================================
function createSocket() {
  const token = localStorage.getItem(STORAGE_KEYS.token);
  const userId = currentUser ? currentUser.id : null;

  if (!userId || !token) {
    return null;
  }

  const client = io({
    auth: {
      userId: String(userId),
      sessionToken: token
    },
    reconnection: true,
    reconnectionAttempts: 5,
    timeout: 10000
  });

  client.on('connect_error', error => {
    console.warn('Socket connect_error:', error.message);
    if (
      error.message === 'Unauthorized' ||
      error.message === 'Authentication failed'
    ) {
      logout();
    }
  });

  return client;
}

function registerSocketEvents() {
  if (!socket || socketBound) return;
  socketBound = true;

  socket.on('connect', () => {
    console.log('Socket terhubung:', socket.id);
  });

  socket.on('chat_history', history => {
    renderChatHistory(history);
  });

  socket.on('receive_message', message => {
    renderIncomingMessage(message);
  });

  socket.on('message_deleted', data => {
    removeMessageFromUI(data.id);
  });

  socket.on('messages_deleted_by_user', data => {
    if (String(data.user_id) === String(currentUser?.id)) {
      clearChatContainer();
    }
  });

  socket.on('online_users_update', () => {
    const familyTab = document.getElementById('content-family');
    if (familyTab && familyTab.classList.contains('active')) {
      loadFamilyMembers();
    }
  });

  socket.on('chat_cleared', clearChatContainer);

  socket.on('incoming_call', data => {
    handleIncomingCall(data);
  });

  socket.on('call_answered', data => {
    void handleCallAnswered(data);
  });

  socket.on('ice_candidate', data => {
    void handleIceCandidate(data);
  });

  socket.on('end_call', () => {
    cleanupCall(false);
  });
}

function connectAuthenticatedSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
    socketBound = false;
  }
  socket = createSocket();
  if (socket) {
    registerSocketEvents();
  }
}

// ==========================================================
// API HELPERS
// ==========================================================
async function parseJsonResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    return {};
  }
  try {
    return await response.json();
  } catch (error) {
    return {};
  }
}

async function apiFetch(url, options = {}) {
  const token = localStorage.getItem(STORAGE_KEYS.token) || '';
  const userId = currentUser ? String(currentUser.id) : '';

  const headers = new Headers(options.headers || {});
  if (userId) headers.set('x-user-id', userId);
  if (token) headers.set('x-session-token', token);

  const requestOptions = {
    ...options,
    headers
  };

  if (requestOptions.body instanceof FormData) {
    requestOptions.headers.delete('Content-Type');
  }

  let response;
  try {
    response = await fetch(url, requestOptions);
  } catch (error) {
    throw new Error('Tidak dapat terhubung ke server.');
  }

  if (response.status === 401 || response.status === 403) {
    const data = await parseJsonResponse(response);
    const shouldLogout =
      response.status === 401 ||
      data.error === 'SESSION_KICKED';

    if (shouldLogout) {
      if (!isLoggingOut) {
        alert(data.message || 'Sesi tidak valid atau telah berakhir. Silakan login ulang.');
      }
      logout();
    }
  }

  return response;
}

// ==========================================================
// SERVICE WORKER / PWA & WEB PUSH NOTIFICATION
// ==========================================================
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js');
      registerPushNotification();

      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        if (!newWorker) return;

        newWorker.addEventListener('statechange', () => {
          if (
            newWorker.state === 'installed' &&
            navigator.serviceWorker.controller
          ) {
            const shouldUpdate = confirm(
              'Versi baru Kitachat tersedia. Perbarui sekarang?'
            );
            if (shouldUpdate) {
              newWorker.postMessage({ type: 'SKIP_WAITING' });
            }
          }
        });
      });

      navigator.serviceWorker.addEventListener(
        'controllerchange',
        () => {
          window.location.reload();
        },
        { once: true }
      );
    } catch (error) {
      console.warn('Service Worker gagal didaftarkan:', error);
    }
  });
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

async function registerPushNotification() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

  try {
    const registration = await navigator.serviceWorker.ready;
    const permissionResult = await Notification.requestPermission();
    if (permissionResult !== 'granted') return;

    const publicVapidKey = 'BJKdEnjNr4C-Rc0WJi05pmu3Uf__jj941_2GiWesMmqRDM267mq3lfi--P7owdTfIDdEqNqNTV3xNe0bAQS_i8g';

    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicVapidKey)
    });

    if (!currentUser) return;

    await apiFetch('/api/save-subscription', {
      method: 'POST',
      body: JSON.stringify(subscription),
      headers: {
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    console.error('Gagal memproses Push Notification:', err);
  }
}

window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  deferredPrompt = event;

  const installContainer = document.getElementById('install-pwa-container');
  if (installContainer) installContainer.classList.remove('hidden');
});

function installAppToAndroid() {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(() => {
      deferredPrompt = null;
    });
  } else {
    alert('Aplikasi sudah terinstal atau browser tidak mendukung instalasi otomatis.');
  }
}

async function forceUpdateApp() {
  if ('serviceWorker' in navigator) {
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration) {
        await registration.update();
        alert('Pemeriksaan selesai. Jika ada versi baru, halaman akan dimuat ulang.');
        window.location.reload();
      }
    } catch (error) {
      console.error('Gagal memeriksa pembaruan:', error);
    }
  }
}

// ==========================================================
// THEME
// ==========================================================
function applySavedTheme() {
  const savedTheme = localStorage.getItem(STORAGE_KEYS.theme);
  const isDark = savedTheme === 'dark';

  document.body.classList.toggle('dark-mode', isDark);
  document.body.classList.toggle('light-mode', !isDark);
}

function toggleTheme() {
  const isDark = document.body.classList.contains('dark-mode');

  document.body.classList.toggle('dark-mode', !isDark);
  document.body.classList.toggle('light-mode', isDark);

  localStorage.setItem(
    STORAGE_KEYS.theme,
    document.body.classList.contains('dark-mode') ? 'dark' : 'light'
  );
}

// ==========================================================
// UI HELPERS & NAVIGATION
// ==========================================================
function showAuthScreen() {
  const authScreen = document.getElementById('auth-screen');
  const mainScreen = document.getElementById('main-screen');

  if (mainScreen) {
    mainScreen.classList.remove('active');
    mainScreen.style.display = 'none';
  }

  if (authScreen) {
    authScreen.classList.add('active');
    authScreen.style.display = 'flex';
  }
}

function showMainScreen() {
  const authScreen = document.getElementById('auth-screen');
  const mainScreen = document.getElementById('main-screen');

  if (authScreen) {
    authScreen.classList.remove('active');
    authScreen.style.display = 'none';
  }

  if (mainScreen) {
    mainScreen.classList.add('active');
    mainScreen.style.display = 'flex';
  }
}

function switchTab(tab) {
  const loginForm = document.getElementById('login-form');
  const registerForm = document.getElementById('register-form');
  const tabLogin = document.getElementById('tab-login');
  const tabRegister = document.getElementById('tab-register');

  if (!loginForm || !registerForm || !tabLogin || !tabRegister) return;

  if (tab === 'login') {
    loginForm.classList.remove('hidden');
    registerForm.classList.add('hidden');
    tabLogin.classList.add('active');
    tabRegister.classList.remove('active');
  } else {
    loginForm.classList.add('hidden');
    registerForm.classList.remove('hidden');
    tabRegister.classList.add('active');
    tabLogin.classList.remove('active');
  }
}

function switchTabNav(tabName) {
  const contents = document.querySelectorAll('.tab-content');
  contents.forEach(content => {
    content.classList.remove('active');
    content.classList.add('hidden');
    content.setAttribute('aria-hidden', 'true');
  });

  const targetContent = document.getElementById(`content-${tabName}`);
  if (targetContent) {
    targetContent.classList.remove('hidden');
    targetContent.classList.add('active');
    targetContent.setAttribute('aria-hidden', 'false');
  }

  const menuButtons = document.querySelectorAll('.menu-item');
  menuButtons.forEach(btn => {
    if (btn.getAttribute('data-tab') === tabName) {
      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
    } else {
      btn.classList.remove('active');
      btn.setAttribute('aria-selected', 'false');
    }
  });

  if (tabName === 'album') {
    loadAlbumPhotos();
  } else if (tabName === 'agenda') {
    loadAgendaAndBirthdays();
  } else if (tabName === 'family') {
    loadFamilyMembers();
  }
}

function updateUserInterface() {
  if (!currentUser) return;

  const names = [
    document.getElementById('user-display-name'),
    document.getElementById('user-display-name-desktop'),
    document.getElementById('settings-user-name')
  ];

  names.forEach(el => {
    if (el) el.textContent = currentUser.name || '';
  });

  const avatarEls = [
    document.getElementById('user-avatar'),
    document.getElementById('user-avatar-desktop'),
    document.getElementById('settings-user-avatar')
  ];

  avatarEls.forEach(el => {
    if (el && currentUser.photo_url) {
      el.src = currentUser.photo_url;
    }
  });

  const phoneEl = document.getElementById('settings-user-phone');
  if (phoneEl) {
    phoneEl.replaceChildren();

    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-phone';

    const textNode = document.createTextNode(` ${currentUser.phone || ''}`);

    phoneEl.appendChild(icon);
    phoneEl.appendChild(textNode);
  }

  showMainScreen();
}

// ==========================================================
// AUTH: REGISTER / LOGIN / LOGOUT
// ==========================================================
async function handleRegister(event) {
  event.preventDefault();

  const name = document.getElementById('reg-name')?.value?.trim() || '';
  const phone = document.getElementById('reg-phone')?.value?.trim() || '';
  const password = document.getElementById('reg-password')?.value || '';
  const birthdate = document.getElementById('reg-birthdate')?.value || '';
  
  const registerTypeEl = document.querySelector('input[name="register_type"]:checked');
  const register_type = registerTypeEl ? registerTypeEl.value : 'create';
  
  const invite_code = document.getElementById('reg-invite-code')?.value?.trim().toUpperCase() || '';

  if (!name || !phone || !password || !register_type) {
    alert('Nomor telepon, nama, password, dan jenis pendaftaran wajib diisi.');
    return;
  }

  if (register_type === 'join' && !invite_code) {
    alert('Kode undangan keluarga wajib diisi jika ingin bergabung.');
    return;
  }

  try {
    const response = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        name, 
        phone, 
        password, 
        birthdate, 
        register_type, 
        invite_code 
      })
    });

    const data = await parseJsonResponse(response);

    if (response.ok) {
      alert(data.message || 'Registrasi berhasil.');
      switchTab('login');
    } else {
      alert(data.error || 'Registrasi gagal.');
    }
  } catch (error) {
    console.error('Error register:', error);
    alert('Terjadi kesalahan jaringan.');
  }
}

async function handleLogin(event) {
  event.preventDefault();

  const phoneInput = document.getElementById('login-phone');
  const passwordInput = document.getElementById('login-password');
  const forgotBtn = document.getElementById('forgot-password-btn');

  const phone = phoneInput ? phoneInput.value.trim() : '';
  const password = passwordInput ? passwordInput.value : '';

  if (!phone || !password) {
    alert('Nomor telepon dan password wajib diisi.');
    return;
  }

  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, password })
    });

    const data = await parseJsonResponse(response);

    if (!response.ok) {
      alert(data.error || 'Login gagal.');

      if (
        data.error === 'Password salah.' ||
        data.error === 'Password salah!'
      ) {
        failedLoginAttempts++;
        if (failedLoginAttempts >= 3 && forgotBtn) {
          forgotBtn.classList.remove('hidden');
        }
      }
      return;
    }

    failedLoginAttempts = 0;
    if (forgotBtn) {
      forgotBtn.classList.add('hidden');
    }

    currentUser = data.user;

    localStorage.setItem(STORAGE_KEYS.user, JSON.stringify(currentUser));
    localStorage.setItem(STORAGE_KEYS.token, data.session_token);

    updateUserInterface();
    connectAuthenticatedSocket();
    registerPushNotification();
  } catch (error) {
    console.error('Error login:', error);
    alert('Tidak dapat terhubung ke server.');
  }
}

function logout() {
  if (isLoggingOut) return;
  isLoggingOut = true;

  cleanupCall(true);

  if (socket) {
    socket.disconnect();
    socket = null;
    socketBound = false;
  }

  currentUser = null;
  clearSavedSession();
  showAuthScreen();

  isLoggingOut = false;
}

// ==========================================================
// CHAT & MESSAGE ACTIONS
// ==========================================================
let pressTimer;

function clearChatContainer() {
  const container = document.getElementById('chat-messages-container');
  if (container) container.replaceChildren();
}

function renderChatHistory(history) {
  const container = document.getElementById('chat-messages-container');
  if (!container) return;
  container.replaceChildren();

  if (!Array.isArray(history) || history.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = 'Belum ada pesan.';
    empty.style.cssText = 'color:gray; text-align:center; padding:12px;';
    container.appendChild(empty);
    return;
  }
  history.forEach(item => renderIncomingMessage(item, true));
}

function renderIncomingMessage(message, silent = false) {
  const container = document.getElementById('chat-messages-container');
  if (!container || !message) return;

  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';
  
  const msgId = String(message.id || '');
  if (msgId) bubble.setAttribute('data-message-id', msgId);
  
  const isMe = currentUser && (message.name === currentUser.name || message.user_id === currentUser.id);
  if (isMe) {
    bubble.classList.add('chat-outgoing');
  } else {
    bubble.classList.add('chat-incoming');
  }

  const startHandler = (e) => handleLongPressStart(e, message, isMe);
  bubble.addEventListener('touchstart', startHandler, { passive: true });
  bubble.addEventListener('mousedown', startHandler);
  
  const cancelHandler = () => clearTimeout(pressTimer);
  bubble.addEventListener('touchend', cancelHandler);
  bubble.addEventListener('touchmove', cancelHandler);
  bubble.addEventListener('mouseup', cancelHandler);
  bubble.addEventListener('mouseleave', cancelHandler);

  const sender = document.createElement('div');
  sender.className = 'chat-sender';
  sender.textContent = message.name || 'Keluarga';
  bubble.appendChild(sender);

  if (message.message && message.message.trim() !== '') {
    const text = document.createElement('div');
    text.className = 'chat-text';
    text.textContent = message.message;
    bubble.appendChild(text);
  }

  if (message.reply_to_id && message.reply_text) {
    const reply = document.createElement('div');
    reply.className = 'chat-reply';
    reply.textContent = `Balasan: ${message.reply_text}`;
    bubble.appendChild(reply);
  }
  
  if (message.image_url) {
    const img = document.createElement('img');
    img.src = message.image_url;
    img.style.cssText = 'max-width:220px; border-radius:10px; display:block; margin-top:5px; cursor:pointer;';
    img.onclick = () => openZoomModal(message.image_url);
    bubble.appendChild(img);
  }
  
  if (message.audio_url) {
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.src = message.audio_url;
    audio.style.cssText = 'margin-top: 4px; width: 210px; height: 32px; display: block;';
    bubble.appendChild(audio);
  }

  const time = document.createElement('div');
  time.className = 'chat-time';
  time.textContent = message.time || '';
  bubble.appendChild(time);

  container.appendChild(bubble);
  if (!silent && typeof chatBeepAudio !== 'undefined') {
    chatBeepAudio.play().catch(() => {});
  }
  container.scrollTop = container.scrollHeight;
}

function handleLongPressStart(e, message, isMe) {
  clearTimeout(pressTimer);
  const x = e.touches ? e.touches[0].pageX : e.pageX;
  const y = e.touches ? e.touches[0].pageY : e.pageY;
  
  pressTimer = setTimeout(() => {
    if (navigator.vibrate) navigator.vibrate(50);
    showChatContextMenu(x, y, message.id, isMe, message.message || "(Media)");
  }, 600);
}

function showChatContextMenu(x, y, id, isMe, text) {
  let menu = document.getElementById('chat-context-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'chat-context-menu';
    menu.className = 'context-menu';
    document.body.appendChild(menu);
  }

  const safeText = text.replace(/'/g, "\\'").replace(/"/g, '"');

  menu.innerHTML = `
    <div class="menu-item" onclick="initiateReply('${id}', '${safeText}')" style="padding:10px; cursor:pointer;">
      <i class="fa-solid fa-reply"></i> Balas
    </div>
    ${isMe ? `
    <div class="menu-item delete" onclick="deleteMessage('${id}')" style="color:red; border-top:1px solid #eee; padding:10px; cursor:pointer;">
      <i class="fa-solid fa-trash"></i> Hapus
    </div>` : ''}
  `;

  menu.style.display = 'block';
  const menuWidth = 150;
  const posX = (x + menuWidth > window.innerWidth) ? (window.innerWidth - menuWidth - 10) : x;
  
  menu.style.left = posX + 'px';
  menu.style.top = y + 'px';

  const closeMenu = () => {
    menu.style.display = 'none';
    document.removeEventListener('click', closeMenu);
  };
  setTimeout(() => document.addEventListener('click', closeMenu), 100);
}

function initiateReply(id, text) {
  window.replyingToMessageId = id;
  const replyContainer = document.getElementById('reply-preview-container');
  const replyText = document.getElementById('reply-preview-text');
  if (replyContainer && replyText) {
    replyText.textContent = text;
    replyContainer.classList.remove('hidden');
    document.getElementById('message-input')?.focus();
  }
}

async function deleteMessage(id) {
  if (!confirm('Hapus pesan ini?')) return;
  try {
    const response = await apiFetch(`/api/messages/${id}`, { 
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }
    });
    
    if (response.ok) {
      removeMessageFromUI(id);
    } else {
      const errorData = await response.json().catch(() => ({}));
      alert(errorData.error || 'Gagal menghapus pesan.');
    }
  } catch (err) {
    alert('Terjadi kesalahan jaringan.');
  }
}

function removeMessageFromUI(id) {
  const bubble = document.querySelector(`.chat-bubble[data-message-id="${id}"]`);
  if (bubble) {
    bubble.style.opacity = '0';
    bubble.style.transform = 'scale(0.9)';
    setTimeout(() => bubble.remove(), 200);
  }
}

function cancelReply() {
  window.replyingToMessageId = null;
  document.getElementById('reply-preview-container')?.classList.add('hidden');
}

async function sendMessage() {
  const input = document.getElementById('message-input');
  if (!input || !input.value.trim()) return;
  if (!currentUser) return alert('Silakan login terlebih dahulu!');

  const formData = new FormData();
  formData.append('message', input.value.trim());
  formData.append('client_time', new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }));

  if (window.replyingToMessageId) {
    formData.append('reply_to_id', String(window.replyingToMessageId));
  }

  try {
    const response = await apiFetch('/api/send-message', { method: 'POST', body: formData });
    if (response.ok) {
      input.value = '';
      input.style.height = 'auto';
      cancelReply();
    }
  } catch (err) {
    alert('Gagal mengirim pesan.');
  }
}

// ==========================================================
// VOICE NOTE RECORDING LOGIC
// ==========================================================
let mediaRecorder = null;
let audioChunks = [];

async function startRecording() {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("Browser Anda tidak mendukung perekaman audio.");
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    
    const mimeTypes = [
      'audio/mp4',
      'audio/aac',
      'audio/webm;codecs=opus', 
      'audio/webm', 
      'audio/ogg;codecs=opus'
    ];
    
    const selectedMime = mimeTypes.find(mime => MediaRecorder.isTypeSupported(mime)) || '';
    const options = selectedMime ? { mimeType: selectedMime } : {};
    
    mediaRecorder = new MediaRecorder(stream, options);
    audioChunks = [];

    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };
    
    mediaRecorder.onstop = async () => {
      resetMicButtonUI();

      const activeMime = mediaRecorder.mimeType || selectedMime || 'audio/mp4';
      const audioBlob = new Blob(audioChunks, { type: activeMime });
      
      let extension = 'm4a'; 
      if (activeMime.includes('webm')) extension = 'webm';
      else if (activeMime.includes('ogg')) extension = 'ogg';
      else if (activeMime.includes('mp4') || activeMime.includes('aac')) extension = 'm4a';

      const file = new File([audioBlob], `voicenote-${Date.now()}.${extension}`, { type: activeMime });
      stream.getTracks().forEach(track => track.stop());
      
      sendVoiceNote(file);
    };

    mediaRecorder.start();
    
    const micBtn = document.getElementById('mic-btn');
    if (micBtn) {
        micBtn.classList.add('recording-active');
        micBtn.innerHTML = '<i class="fa-solid fa-stop" style="color: #e74c3c;"></i>'; 
        micBtn.title = "Ketuk untuk berhenti dan kirim";
    }
  } catch (err) {
    console.error("Recording Error:", err);
    alert(err.message || "Gagal mengakses mikrofon.");
    resetMicButtonUI();
  }
}

async function sendVoiceNote(file) {
  if (typeof currentUser === 'undefined' || !currentUser) {
    console.warn('Silakan login terlebih dahulu!');
    return;
  }
  
  const formData = new FormData();
  formData.append('media', file);
  formData.append('client_time', new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }));

  try {
    const response = await apiFetch('/api/send-message', {
      method: 'POST',
      body: formData
    });
    
    const data = await parseJsonResponse(response);
    if (!response.ok) {
      throw new Error(data.error || "Gagal mengunggah ke server.");
    }
  } catch (error) {
    console.error("Gagal mengirim Voice Note:", error.message);
  }
}

function resetMicButtonUI() {
  const micBtn = document.getElementById('mic-btn');
  if (micBtn) {
      micBtn.classList.remove('recording-active');
      micBtn.innerHTML = '<i class="fa-solid fa-microphone"></i>';
      micBtn.style.color = '';
      micBtn.title = "Kirim pesan suara";
      micBtn.disabled = false;
  }
}

document.addEventListener('click', (e) => {
    const btn = e.target.closest('#mic-btn');
    if (!btn) return;

    if (mediaRecorder && mediaRecorder.state === "recording") {
        mediaRecorder.stop();
    } else {
        startRecording();
    }
});

// ==========================================================
// TELEPON CEPAT DARI OBROLAN (CHAT CALL MENU)
// ==========================================================
async function openCallMenu() {
  try {
    const response = await apiFetch('/api/users');
    if (!response.ok) return;
    
    const users = await response.json();
    const otherMembers = users.filter(u => String(u.id) !== String(currentUser?.id));

    if (otherMembers.length === 0) {
      alert('Tidak ada anggota keluarga lain yang tersedia untuk ditelepon.');
      return;
    }

    const container = document.getElementById('call-selection-list');
    if (!container) return;
    container.replaceChildren();

    otherMembers.forEach(user => {
      const item = document.createElement('div');
      item.style.cssText = 'display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; background: var(--bg-color); border: 1px solid var(--border-color); border-radius: 8px; cursor: pointer; transition: background 0.2s;';
      
      const statusColor = user.is_online ? '#27ae60' : '#95a5a6';
      const statusText = user.is_online ? 'Online' : 'Offline';

      item.innerHTML = `
        <div style="display: flex; align-items: center; gap: 10px;">
          <div style="position: relative;">
            <img src="${user.photo_url || '/logo-192.png'}" alt="${user.name}" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover; border: 1px solid var(--primary-color);">
            <span style="position: absolute; bottom: 0; right: 0; width: 10px; height: 10px; background: ${statusColor}; border: 1px solid var(--card-bg); border-radius: 50%;"></span>
          </div>
          <div style="text-align: left;">
            <strong style="font-size: 14px; color: var(--text-light); display: block;">${user.name}</strong>
            <span style="font-size: 11px; color: ${statusColor}; font-weight: 600;">${statusText}</span>
          </div>
        </div>
        <button type="button" style="background: var(--primary-color); color: white; border: none; width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer;" aria-label="Telepon ${user.name}">
          <i class="fa-solid fa-phone" style="font-size: 12px;" aria-hidden="true"></i>
        </button>
      `;

      item.onclick = () => {
        closeCallSelectionModal();
        startCall(user.id, user.name);
      };

      container.appendChild(item);
    });

    document.getElementById('call-selection-modal')?.classList.remove('hidden');
  } catch (error) {
    console.error('Gagal membuka menu panggilan:', error);
    alert('Terjadi kesalahan saat memuat daftar keluarga.');
  }
}

function closeCallSelectionModal() {
  document.getElementById('call-selection-modal')?.classList.add('hidden');
}

// ==========================================================
// ALBUM
// ==========================================================
let currentAlbumFilter = 'semua';
let globalAlbumData = [];
let albumRequestId = 0;
const ALBUM_MAX_FILE_SIZE = 10 * 1024 * 1024;

function getAlbumElements() {
  return {
    grid: document.getElementById('album-grid-container'),
    fileInput: document.getElementById('photo-file-input'),
    fileNameLabel: document.getElementById('selected-file-label'),
    formCard: document.getElementById('photo-upload-form'),
    captionInput: document.getElementById('photo-caption-input'),
    submitBtn: document.querySelector('#photo-upload-form button[type="submit"]')
  };
}

function onAlbumFileChange(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  const { fileNameLabel, formCard } = getAlbumElements();
  if (fileNameLabel) {
    fileNameLabel.textContent = file.name;
  }

  const preview = document.getElementById('photo-preview');
  if (preview && formCard) {
    const reader = new FileReader();
    reader.onload = function (e) {
      preview.src = e.target.result;
      preview.hidden = false;
      preview.classList.remove('hidden');
    };
    reader.readAsDataURL(file);
    formCard.classList.remove('hidden');
  }
}

function cancelAlbumUpload() {
  const { fileInput, captionInput, formCard } = getAlbumElements();

  if (fileInput) fileInput.value = '';
  if (captionInput) captionInput.value = '';

  const preview = document.getElementById('photo-preview');
  if (preview) {
    preview.src = '';
    preview.hidden = true;
    preview.classList.add('hidden');
  }

  if (formCard) {
    formCard.classList.add('hidden');
  }

  const label = document.getElementById('selected-file-label');
  if (label) {
    label.textContent = 'Ketuk untuk pilih dari galeri atau kamera';
  }
}

function renderAlbumGrid(photos) {
  const { grid: container } = getAlbumElements();
  if (!container) return;

  container.replaceChildren();

  if (!Array.isArray(photos) || photos.length === 0) {
    const p = document.createElement('p');
    p.textContent = 'Belum ada foto di album.';
    p.style.color = 'gray';
    p.style.gridColumn = 'span 3';
    p.style.textAlign = 'center';
    p.style.padding = '20px';
    container.appendChild(p);
    return;
  }

  photos.forEach((item, index) => {
    const card = document.createElement('div');
    card.style.position = 'relative';
    card.style.width = '100%';
    card.style.aspectRatio = '1 / 1';
    card.style.borderRadius = '4px';
    card.style.overflow = 'hidden';
    card.style.background = '#ddd';
    card.style.cursor = 'pointer';

    const img = document.createElement('img');
    img.src = item.image_url;
    img.alt = item.caption || 'Foto';
    img.style.width = '100%';
    img.style.height = '100%';
    img.style.objectFit = 'cover';
    img.onclick = () => openZoomModal(item.image_url);

    const menuId = `album-menu-${item.id || index}`;
    const menuBtn = document.createElement('button');
    menuBtn.className = 'photo-menu-btn';
    menuBtn.innerHTML = '<i class="fa-solid fa-ellipsis-vertical"></i>';
    menuBtn.style.position = 'absolute';
    menuBtn.style.right = '8px';
    menuBtn.style.bottom = '8px';
    menuBtn.style.width = '28px';
    menuBtn.style.height = '28px';
    menuBtn.style.borderRadius = '50%';
    menuBtn.style.border = 'none';
    menuBtn.style.background = 'rgba(0,0,0,0.6)';
    menuBtn.style.color = 'white';
    menuBtn.onclick = event => togglePhotoMenu(event, menuId);

    const dropdown = document.createElement('div');
    dropdown.id = menuId;
    dropdown.className = 'photo-dropdown';

    const downloadBtn = document.createElement('button');
    downloadBtn.textContent = 'Simpan';
    downloadBtn.onclick = () => downloadPhoto(item.image_url);
    dropdown.appendChild(downloadBtn);

    const isOwner =
      currentUser &&
      String(currentUser.id) === String(item.user_id);

    if (isOwner) {
      const deleteBtn = document.createElement('button');
      deleteBtn.textContent = 'Hapus';
      deleteBtn.style.color = '#e74c3c';
      deleteBtn.onclick = () => deleteAlbumPhoto(item.id);
      dropdown.appendChild(deleteBtn);
    }

    card.appendChild(img);
    card.appendChild(menuBtn);
    card.appendChild(dropdown);
    container.appendChild(card);
  });
}

function filterAlbum(type) {
  currentAlbumFilter = type;

  ['tahun', 'bulan', 'semua'].forEach(key => {
    const btn = document.getElementById(`filter-btn-${key}`);
    if (!btn) return;

    if (key === type) {
      btn.style.background = 'white';
      btn.style.color = '#111';
      btn.style.fontWeight = 'bold';
      btn.style.boxShadow = '0 2px 5px rgba(0,0,0,0.2)';
    } else {
      btn.style.background = 'transparent';
      btn.style.color = '#aaa';
      btn.style.fontWeight = '500';
      btn.style.boxShadow = 'none';
    }
  });

  let filtered = [...globalAlbumData];
  const now = new Date();

  if (type === 'tahun') {
    filtered = globalAlbumData.filter(item => {
      const d = new Date(item.created_at);
      return d.getFullYear() === now.getFullYear();
    });
  } else if (type === 'bulan') {
    filtered = globalAlbumData.filter(item => {
      const d = new Date(item.created_at);
      return (
        d.getMonth() === now.getMonth() &&
        d.getFullYear() === now.getFullYear()
      );
    });
  }

  renderAlbumGrid(filtered);
}

async function loadAlbumPhotos() {
  const currentReqId = ++albumRequestId;

  try {
    const response = await apiFetch('/api/albums');
    if (currentReqId !== albumRequestId) return;

    if (response.ok) {
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const data = await response.json();
        globalAlbumData = Array.isArray(data) ? data : [];
        renderAlbumGrid(globalAlbumData);
      }
    }
  } catch (error) {
    console.error('Gagal memuat album:', error);
  }
}

async function handleUploadPhoto(event) {
  event.preventDefault();

  if (!currentUser) {
    alert('Silakan login terlebih dahulu!');
    return;
  }

  const { fileInput, captionInput, submitBtn } = getAlbumElements();

  if (!fileInput || fileInput.files.length === 0) {
    alert('Pilih file gambar terlebih dahulu!');
    return;
  }

  const file = fileInput.files[0];
  if (!file.type.startsWith('image/')) {
    alert('File harus berupa gambar.');
    return;
  }

  if (file.size > ALBUM_MAX_FILE_SIZE) {
    alert('Ukuran file maksimal 10MB.');
    return;
  }

  const formData = new FormData();
  formData.append('image', file);
  formData.append('caption', captionInput ? captionInput.value : '');

  if (submitBtn) submitBtn.disabled = true;

  try {
    const response = await apiFetch('/api/albums', {
      method: 'POST',
      body: formData
    });

    const data = await parseJsonResponse(response);

    if (response.ok) {
      cancelAlbumUpload();
      switchTabNav('album');
      await loadAlbumPhotos();
    } else {
      alert(data.error || 'Gagal mengunggah foto.');
    }
  } catch (error) {
    console.error('Error upload foto:', error);
    alert('Terjadi kesalahan jaringan.');
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

function togglePhotoMenu(event, menuId) {
  event.stopPropagation();
  document.querySelectorAll('.photo-dropdown').forEach(el => {
    if (el.id !== menuId) el.classList.remove('active');
  });
  const dropdown = document.getElementById(menuId);
  if (dropdown) dropdown.classList.toggle('active');
}

window.addEventListener('click', () => {
  document.querySelectorAll('.photo-dropdown').forEach(el => {
    el.classList.remove('active');
  });
});

function openZoomModal(imageUrl) {
  const modal = document.getElementById('photo-zoom-modal');
  const img = document.getElementById('zoomed-img-element');

  if (modal && img) {
    img.src = imageUrl;
    modal.classList.remove('hidden');
    modal.style.display = 'flex';
  }
}

function closeZoomModal() {
  const modal = document.getElementById('photo-zoom-modal');
  if (modal) {
    modal.classList.add('hidden');
    modal.style.display = 'none';
  }
}

async function downloadPhoto(imageUrl) {
  try {
    const response = await fetch(imageUrl);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `kitachat-foto-${Date.now()}.jpg`;
    document.body.appendChild(a);
    a.click();
    a.remove();

    URL.revokeObjectURL(url);
  } catch (error) {
    alert('Gagal menyimpan foto.');
  }
}

async function deleteAlbumPhoto(photoId) {
  if (!confirm('Apakah Anda yakin ingin menghapus foto ini?')) return;

  try {
    const response = await apiFetch(`/api/albums/${photoId}`, {
      method: 'DELETE'
    });

    const data = await parseJsonResponse(response);

    if (response.ok) {
      alert(data.message || 'Foto berhasil dihapus.');
      await loadAlbumPhotos();
    } else {
      alert(data.error || 'Gagal menghapus foto.');
    }
  } catch (error) {
    console.error('Error delete album:', error);
  }
}

// ==========================================================
// AGENDA & BIRTHDAYS LOGIC
// ==========================================================
function toggleAgendaForm() {
  const form = document.getElementById('agenda-form-container');
  const label = document.getElementById('agenda-toggle-label');
  const chevron = document.getElementById('agenda-chevron-icon');

  if (!form) return;

  const isHidden = form.classList.contains('hidden') || form.style.display === 'none';

  if (isHidden) {
    form.classList.remove('hidden');
    form.style.display = 'flex';
    if (label) label.innerText = 'Tutup formulir agenda';
    if (chevron) chevron.style.transform = 'rotate(90deg)';
  } else {
    form.classList.add('hidden');
    form.style.display = 'none';
    if (label) label.innerText = 'Ketuk untuk membuat jadwal baru';
    if (chevron) chevron.style.transform = 'rotate(0deg)';
  }
}

async function handleCreateAgenda(event) {
  event.preventDefault();

  if (!currentUser) {
    alert('Silakan login terlebih dahulu!');
    return;
  }

  const title = document.getElementById('agenda-title')?.value.trim() || '';
  const eventDate = document.getElementById('agenda-date')?.value || '';
  const description = document.getElementById('agenda-desc')?.value || '';

  if (!title || !eventDate) {
    alert('Judul dan tanggal acara wajib diisi.');
    return;
  }

  try {
    const response = await apiFetch('/api/agendas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, event_date: eventDate, description })
    });

    const data = await parseJsonResponse(response);

    if (response.ok) {
      alert(data.message || 'Agenda berhasil dibuat.');

      ['agenda-title', 'agenda-date', 'agenda-desc'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });

      const form = document.getElementById('agenda-form-container');
      const label = document.getElementById('agenda-toggle-label');
      const chevron = document.getElementById('agenda-chevron-icon');

      if (form) {
        form.classList.add('hidden');
        form.style.display = 'none';
      }
      if (label) label.innerText = 'Ketuk untuk membuat jadwal baru';
      if (chevron) chevron.style.transform = 'rotate(0deg)';

      await loadAgendaAndBirthdays();
    } else {
      alert(data.error || 'Gagal menambahkan agenda.');
    }
  } catch (error) {
    console.error('Error create agenda:', error);
    alert('Terjadi kesalahan jaringan.');
  }
}

async function loadAgendaAndBirthdays() {
  try {
    const response = await apiFetch('/api/family-birthdays');
    const members = await parseJsonResponse(response);
    const bdayContainer = document.getElementById('birthday-list-container');

    if (bdayContainer) {
      if (!response.ok) throw new Error("Gagal mengambil data ulang tahun.");

      if (members.length === 0) {
        bdayContainer.innerHTML = `<p style="grid-column: span 4; text-align: center; color: #64748b; font-size: 13px;">Belum ada data anggota keluarga.</p>`;
      } else {
        bdayContainer.innerHTML = members.map(member => {
          const formattedDate = member.birth_date ? formatDateIndo(member.birth_date) : "Tanggal belum diatur";
          const avatarSrc = member.profile_picture || 'https://via.placeholder.com/150';

          return `
            <div class="birthday-card">
              <img src="${avatarSrc}" alt="${member.name}" class="birthday-avatar">
              <h4 class="birthday-name" title="${member.name}">${member.name}</h4>
              <p class="birthday-date"><i class="fa-solid fa-cake-candles" style="color: #e74c3c;"></i> ${formattedDate}</p>
              <span class="birthday-badge">Keluarga</span>
            </div>
          `;
        }).join('');
      }
    }
  } catch (error) {
    console.warn('Gagal memuat data ulang tahun:', error);
    const bdayContainer = document.getElementById('birthday-list-container');
    if (bdayContainer) {
      bdayContainer.innerHTML = `<p style="grid-column: span 4; text-align: center; color: #e74c3c; font-size: 13px;">Gagal memuat daftar ulang tahun.</p>`;
    }
  }

  try {
    const resAgendas = await apiFetch('/api/agendas');
    if (resAgendas.ok) {
      const agendas = await resAgendas.json();
      const agendaContainer = document.getElementById('agenda-list-container');

      if (agendaContainer) {
        agendaContainer.replaceChildren();

        if (agendas.length === 0) {
          agendaContainer.innerHTML = '<p style="font-size: 13px; color: gray;">Belum ada agenda kegiatan tercatat.</p>';
        } else {
          agendas.forEach((item, index) => {
            const fDate = new Date(item.event_date).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
            const card = document.createElement('div');
            card.setAttribute('data-agenda-id', item.id);
            card.style.cssText = 'padding: 14px 16px; background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 10px; display: flex; flex-direction: column; gap: 6px; box-shadow: 0 1px 3px rgba(0,0,0,0.02); position: relative;';

            const menuId = `agenda-menu-${item.id || index}`;

            card.innerHTML = `
              <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 10px;">
                <div style="display: flex; flex-direction: column; gap: 2px;">
                  <h5 style="margin: 0; font-size: 15px; font-weight: 600; color: var(--text-light);">${item.title}</h5>
                  <span style="font-size: 12px; font-weight: bold; color: var(--primary-color); background: var(--primary-light); padding: 3px 8px; border-radius: 6px; width: fit-content;">${fDate}</span>
                </div>
                <div style="position: relative;">
                  <button type="button" onclick="toggleAgendaMenu(event, '${menuId}')" style="background:transparent; border:none; color:var(--text-muted); cursor:pointer; padding:4px 8px; font-size:16px;" title="Menu"><i class="fa-solid fa-ellipsis-vertical"></i></button>
                  <div id="${menuId}" class="photo-dropdown" style="right: 0; bottom: auto; top: 28px; min-width: 110px;">
                    <button type="button" onclick="deleteAgenda('${item.id}')" style="color: #e74c3c; display: flex; align-items: center; gap: 6px; padding: 8px 12px; width: 100%; background: transparent; border: none; cursor: pointer; text-align: left; font-size: 0.82rem;">
                      <i class="fa-solid fa-trash-can"></i> Hapus
                    </button>
                  </div>
                </div>
              </div>
              ${item.description ? `<p style="margin: 0; font-size: 13px; color: var(--text-muted); line-height: 1.4;">${item.description}</p>` : ''}
            `;
            agendaContainer.appendChild(card);
          });
        }
      }
    }
  } catch (error) {
    console.warn('Gagal memuat agenda:', error);
  }
}

function formatDateIndo(dateString) {
  const options = { day: 'numeric', month: 'long' };
  return new Date(dateString).toLocaleDateString('id-ID', options);
}

function toggleAgendaMenu(event, menuId) {
  event.stopPropagation();
  document.querySelectorAll('.photo-dropdown').forEach(el => {
    if (el.id !== menuId) el.classList.remove('active');
  });
  const dropdown = document.getElementById(menuId);
  if (dropdown) dropdown.classList.toggle('active');
}

async function deleteAgenda(id) {
  if (!confirm('Apakah Anda yakin ingin menghapus agenda ini?')) return;

  try {
    const response = await apiFetch(`/api/agendas/${id}`, {
      method: 'DELETE'
    });

    if (response.ok) {
      const card = document.querySelector(`[data-agenda-id="${id}"]`);
      if (card) {
        card.style.transition = 'all 0.2s ease';
        card.style.opacity = '0';
        card.style.transform = 'scale(0.9)';
        setTimeout(() => card.remove(), 200);
      } else {
        await loadAgendaAndBirthdays();
      }
    } else {
      let errorMsg = 'Gagal menghapus agenda.';
      try {
        const data = await response.json();
        if (data && data.error) errorMsg = data.error;
      } catch (e) {}
      alert(errorMsg);
    }
  } catch (error) {
    console.error('Error delete agenda:', error);
    alert('Terjadi kesalahan jaringan.');
  }
}

// ==========================================================
// KELUARGA (FAMILY DIRECTORY DENGAN STATUS ONLINE)
// ==========================================================
async function loadFamilyMembers() {
  try {
    const response = await apiFetch('/api/users');
    if (!response.ok) return;

    const users = await response.json();
    const container = document.getElementById('family-list-container');
    if (!container) return;

    container.replaceChildren();

    if (!Array.isArray(users) || users.length === 0) {
      container.innerHTML = '<p style="color: gray; text-align: center; grid-column: span 3;">Belum ada anggota keluarga.</p>';
      return;
    }

    users.forEach(user => {
      const card = document.createElement('div');
      card.className = 'family-card';
      card.style.cssText = 'display: flex; flex-direction: column; align-items: center; gap: 8px; background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 12px; padding: 20px 15px; box-shadow: var(--shadow-soft); text-align: center; position: relative;';

      const statusColor = user.is_online ? '#27ae60' : '#95a5a6';
      const statusText = user.is_online ? 'Online' : 'Offline';

      card.innerHTML = `
        <div style="position: relative;">
          <img src="${user.photo_url || '/logo-192.png'}" alt="${user.name}" style="width: 65px; height: 65px; border-radius: 50%; object-fit: cover; border: 2px solid var(--primary-color);">
          <span style="position: absolute; bottom: 2px; right: 2px; width: 14px; height: 14px; background: ${statusColor}; border: 2px solid var(--card-bg); border-radius: 50%;" title="${statusText}"></span>
        </div>
        <h4 style="font-size: 1rem; font-weight: 700; color: var(--text-light); margin: 4px 0 0 0;">${user.name}</h4>
        <p style="color: var(--text-muted); font-size: 0.82rem; margin: 0;">${user.phone || ''}</p>
        <span style="font-size: 0.75rem; color: ${statusColor}; font-weight: 600; margin-top: 2px;">${statusText}</span>
      `;
      container.appendChild(card);
    });
  } catch (error) {
    console.error('Gagal memuat daftar keluarga:', error);
  }
}

// ==========================================================
// PROFILE / PASSWORD / EMAIL
// ==========================================================
async function triggerUploadProfile(inputElement) {
  if (!inputElement.files || !inputElement.files[0]) return;

  if (!currentUser) {
    alert('Silakan login terlebih dahulu!');
    return;
  }

  const formData = new FormData();
  formData.append('image', inputElement.files[0]);

  try {
    const response = await apiFetch('/api/update-photo', {
      method: 'POST',
      body: formData
    });

    const data = await parseJsonResponse(response);

    if (response.ok) {
      alert(data.message || 'Foto profil berhasil diperbarui.');
      currentUser = data.user;
      localStorage.setItem(STORAGE_KEYS.user, JSON.stringify(currentUser));
      updateUserInterface();
    } else {
      alert(data.error || 'Gagal memperbarui foto profil.');
    }
  } catch (error) {
    console.error('Error update foto profil:', error);
    alert('Terjadi kesalahan jaringan.');
  } finally {
    inputElement.value = '';
  }
}

function openChangePasswordModal() {
  const modal = document.getElementById('password-modal');
  if (modal) modal.classList.remove('hidden');
}

function closeChangePasswordModal() {
  const modal = document.getElementById('password-modal');
  if (modal) modal.classList.add('hidden');

  const oldPw = document.getElementById('old-password');
  const newPw = document.getElementById('new-password');

  if (oldPw) oldPw.value = '';
  if (newPw) newPw.value = '';
}

async function handleChangePassword(event) {
  event.preventDefault();

  if (!currentUser) {
    alert('Silakan login terlebih dahulu!');
    return;
  }

  const oldPassword = document.getElementById('old-password')?.value || '';
  const newPassword = document.getElementById('new-password')?.value || '';

  if (!oldPassword || !newPassword) {
    alert('Password lama dan baru wajib diisi.');
    return;
  }

  try {
    const response = await apiFetch('/api/update-password', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ old_password: oldPassword, new_password: newPassword })
    });

    const data = await parseJsonResponse(response);

    if (response.ok) {
      closeChangePasswordModal();
      setTimeout(() => {
        alert(data.message || 'Password berhasil diubah.');
      }, 200);
    } else {
      alert(data.error || 'Gagal mengganti password.');
    }
  } catch (error) {
    console.error('Error ganti password:', error);
    alert('Terjadi kesalahan jaringan.');
  }
}

async function handleUpdateEmail(event) {
  event.preventDefault();

  if (!currentUser) {
    alert('Silakan login terlebih dahulu!');
    return;
  }

  const email = document.getElementById('recovery-email')?.value.trim() || '';

  if (!email) {
    alert('Email wajib diisi.');
    return;
  }

  try {
    const response = await apiFetch('/api/update-email', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });

    const data = await parseJsonResponse(response);

    if (response.ok) {
      alert(data.message || 'Email berhasil disimpan.');
      const modal = document.getElementById('email-modal');
      if (modal) modal.classList.add('hidden');
    } else {
      alert(data.error || 'Gagal menyimpan email.');
    }
  } catch (error) {
    console.error('Error update email:', error);
    alert('Kesalahan jaringan.');
  }
}

// ==========================================================
// FORGOT PASSWORD / RESET
// ==========================================================
async function requestOTP() {
  const phone = document.getElementById('login-phone')?.value.trim() || '';

  if (!phone) {
    alert('Masukkan nomor telepon Anda terlebih dahulu.');
    return;
  }

  try {
    const response = await fetch('/api/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone })
    });

    const data = await parseJsonResponse(response);

    if (response.ok) {
      alert(data.message || 'Kode OTP telah dikirim.');
      const otpModal = document.getElementById('otp-modal');
      if (otpModal) otpModal.classList.remove('hidden');
    } else {
      alert(data.error || 'Gagal mengirim OTP.');
    }
  } catch (error) {
    console.error('Error request OTP:', error);
    alert('Terjadi kesalahan jaringan.');
  }
}

async function handleResetPassword(event) {
  event.preventDefault();

  const phone = document.getElementById('login-phone')?.value.trim() || '';
  const otp = document.getElementById('reset-otp')?.value.trim() || '';
  const newPassword = document.getElementById('reset-new-password')?.value || '';

  if (!phone || !otp || !newPassword) {
    alert('Phone, OTP, dan password baru wajib diisi.');
    return;
  }

  try {
    const response = await fetch('/api/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, otp, new_password: newPassword })
    });

    const data = await parseJsonResponse(response);

    if (response.ok) {
      alert(data.message || 'Password berhasil diubah.');

      const otpModal = document.getElementById('otp-modal');
      const forgotBtn = document.getElementById('forgot-password-btn');
      const loginPw = document.getElementById('login-password');

      if (otpModal) otpModal.classList.add('hidden');
      if (forgotBtn) forgotBtn.classList.add('hidden');
      if (loginPw) loginPw.value = '';

      failedLoginAttempts = 0;
    } else {
      alert(data.error || 'Gagal reset password.');
    }
  } catch (error) {
    console.error('Error reset password:', error);
    alert('Kesalahan jaringan.');
  }
}

// ==========================================================
// CLEAR CHAT (DELETE ALL)
// ==========================================================
function clearChat() {
  if (!confirm('Yakin ingin menghapus semua riwayat obrolan Anda?')) return;

  apiFetch('/api/messages', { method: 'DELETE' })
    .then(async response => {
      const data = await parseJsonResponse(response);

      if (response.ok) {
        alert(data.message || 'Riwayat obrolan berhasil dihapus.');
        clearChatContainer();
      } else {
        alert(data.error || 'Gagal membersihkan obrolan.');
      }
    })
    .catch(error => {
      console.error('Error clear chat:', error);
      alert('Terjadi kesalahan saat membersihkan obrolan.');
    });
}

// ==========================================================
// WEBRTC & VoIP CONFIGURATION (SOCKET.IO SIGNALING)
// ==========================================================
function createPeerConnection(expectedCallId = activeCallId) {
  const connection = new RTCPeerConnection(rtcConfig);

  connection.onicecandidate = event => {
    if (
      !event.candidate ||
      !currentUser?.id ||
      !targetUserId ||
      !expectedCallId ||
      activeCallId !== expectedCallId
    ) {
      return;
    }

    const candidate = event.candidate.toJSON
      ? event.candidate.toJSON()
      : event.candidate;

    void sendCallSignal('ice_candidate', targetUserId, { candidate });
  };

  connection.ontrack = event => {
    const remoteAudio = document.getElementById('remote-audio');
    if (!remoteAudio || !event.streams?.[0]) return;

    remoteAudio.srcObject = event.streams[0];
    setCallStatus('Terhubung');

    remoteAudio.play().catch(error => {
      console.warn('Audio remote belum dapat diputar:', error);
    });
  };

  connection.oniceconnectionstatechange = () => {
    if (
      activeCallId !== expectedCallId ||
      peerConnection !== connection
    ) {
      return;
    }

    const state = connection.iceConnectionState;
    if (state === 'connected' || state === 'completed') {
      setCallStatus('Terhubung');
    } else if (state === 'disconnected') {
      setCallStatus('Koneksi terputus sementara...');
    } else if (state === 'failed' || state === 'closed') {
      cleanupCall(false);
    }
  };

  return connection;
}

function cleanupCall(notifyPeer = false) {
  const callIdToEnd = activeCallId;
  const peerToNotify = targetUserId;

  if (notifyPeer && callIdToEnd && peerToNotify && currentUser?.id) {
    void sendCallSignal('end_call', peerToNotify);
  }

  callRingtone.pause();
  callRingtone.currentTime = 0;

  const remoteAudio = document.getElementById('remote-audio');
  if (remoteAudio) {
    remoteAudio.pause();
    remoteAudio.srcObject = null;
  }

  const streamToStop = localStream;
  localStream = null;
  if (streamToStop) {
    streamToStop.getTracks().forEach(track => track.stop());
  }

  const connectionToClose = peerConnection;
  peerConnection = null;
  if (connectionToClose) {
    connectionToClose.close();
  }

  const modal = document.getElementById('call-modal');
  if (modal) modal.classList.add('hidden');

  const acceptBtn = document.getElementById('btn-accept-call');
  if (acceptBtn) acceptBtn.style.display = 'none';

  targetUserId = null;
  activeCallId = null;
  incomingOffer = null;
  iceCandidateQueue = [];
  acceptingCall = false;

  if (callIdToEnd) {
    pendingIceByCallId.delete(String(callIdToEnd));
  }
  pendingIceByCallId.clear();
}

function hangUpCall() {
  cleanupCall(true);
}

async function startCall(peerUserId, peerName) {
  if (!currentUser?.id) {
    alert('Silakan login terlebih dahulu!');
    return;
  }

  if (!socket || !socket.connected) {
    alert('Koneksi socket belum siap. Silakan coba lagi.');
    return;
  }

  if (activeCallId) {
    alert('Anda sedang berada dalam panggilan.');
    return;
  }

  const peerId = normalizeCallUserId(peerUserId);
  if (!peerId || peerId === normalizeCallUserId(currentUser.id)) {
    alert('Pengguna tujuan panggilan tidak valid.');
    return;
  }

  const thisCallId = createCallId();
  activeCallId = thisCallId;
  targetUserId = peerId;
  iceCandidateQueue = [];
  incomingOffer = null;
  acceptingCall = false;

  const modal = document.getElementById('call-modal');
  if (modal) modal.classList.remove('hidden');

  const peerNameEl = document.getElementById('call-peer-name');
  const acceptBtn = document.getElementById('btn-accept-call');

  setCallStatus('Memanggil...');
  if (peerNameEl) peerNameEl.innerText = peerName || 'Keluarga';
  if (acceptBtn) acceptBtn.style.display = 'none';

  let stream = null;

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false
    });

    if (activeCallId !== thisCallId) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }

    localStream = stream;
    peerConnection = createPeerConnection(thisCallId);

    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    if (activeCallId !== thisCallId || !peerConnection?.localDescription) {
      return;
    }

    const localOffer = peerConnection.localDescription.toJSON
      ? peerConnection.localDescription.toJSON()
      : {
          type: peerConnection.localDescription.type,
          sdp: peerConnection.localDescription.sdp
        };

    const sent = await sendCallSignal('offer', peerId, {
      callerName: currentUser.name || 'Keluarga',
      offer: localOffer
    });

    if (!sent && activeCallId === thisCallId) {
      cleanupCall(false);
      alert('Sinyal panggilan gagal dikirim. Coba lagi.');
    }
  } catch (error) {
    console.error('Error startCall:', error);
    if (activeCallId === thisCallId) {
      cleanupCall(false);
      alert('Panggilan gagal dimulai. Periksa izin mikrofon dan koneksi Anda.');
    } else if (stream) {
      stream.getTracks().forEach(track => track.stop());
    }
  }
}

function handleIncomingCall(data) {
  if (
    !currentUser?.id ||
    !data ||
    !data.callId ||
    !data.fromUserId ||
    normalizeCallUserId(data.fromUserId) === normalizeCallUserId(currentUser.id) ||
    !isValidCallDescription(data.offer, 'offer')
  ) {
    return;
  }

  if (activeCallId) return;

  const thisCallId = String(data.callId);
  activeCallId = thisCallId;
  targetUserId = normalizeCallUserId(data.fromUserId);
  incomingOffer = data.offer;
  iceCandidateQueue = [];
  acceptingCall = false;

  const pendingEntry = pendingIceByCallId.get(thisCallId);
  if (
    pendingEntry &&
    pendingEntry.fromUserId === targetUserId &&
    Date.now() - pendingEntry.createdAt <= PENDING_ICE_TTL_MS
  ) {
    iceCandidateQueue.push(...pendingEntry.candidates);
    iceCandidateQueue = iceCandidateQueue.slice(-MAX_ICE_CANDIDATES);
  }
  pendingIceByCallId.delete(thisCallId);

  const modal = document.getElementById('call-modal');
  if (modal) modal.classList.remove('hidden');

  const peerNameEl = document.getElementById('call-peer-name');
  const acceptBtn = document.getElementById('btn-accept-call');

  setCallStatus('Panggilan Masuk...');
  if (peerNameEl) peerNameEl.innerText = data.callerName || 'Keluarga';
  if (acceptBtn) acceptBtn.style.display = 'inline-block';

  callRingtone.play().catch(error => {
    console.warn('Nada dering tidak dapat diputar:', error);
  });
}

async function acceptCall() {
  if (
    !incomingOffer ||
    !activeCallId ||
    !targetUserId ||
    acceptingCall ||
    !socket ||
    !socket.connected
  ) {
    return;
  }

  const thisCallId = activeCallId;
  const offer = incomingOffer;
  acceptingCall = true;

  callRingtone.pause();
  callRingtone.currentTime = 0;

  const acceptBtn = document.getElementById('btn-accept-call');
  if (acceptBtn) acceptBtn.style.display = 'none';

  setCallStatus('Menghubungkan...');

  let stream = null;

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false
    });

    if (activeCallId !== thisCallId) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }

    localStream = stream;
    peerConnection = createPeerConnection(thisCallId);

    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });

    const connection = peerConnection;
    await connection.setRemoteDescription(new RTCSessionDescription(offer));

    if (activeCallId !== thisCallId || peerConnection !== connection) {
      return;
    }

    incomingOffer = null;
    await drainIceCandidateQueue(thisCallId, connection);

    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);

    if (activeCallId !== thisCallId || !connection.localDescription) {
      return;
    }

    const localAnswer = connection.localDescription.toJSON
      ? connection.localDescription.toJSON()
      : {
          type: connection.localDescription.type,
          sdp: connection.localDescription.sdp
        };

    const sent = await sendCallSignal('answer', targetUserId, {
      answer: localAnswer
    });

    if (!sent && activeCallId === thisCallId) {
      cleanupCall(false);
      alert('Jawaban panggilan gagal dikirim. Coba lagi.');
    }
  } catch (error) {
    console.error('Error acceptCall:', error);
    if (activeCallId === thisCallId) {
      cleanupCall(true);
      alert('Panggilan gagal diterima. Periksa izin mikrofon dan koneksi Anda.');
    } else if (stream) {
      stream.getTracks().forEach(track => track.stop());
    }
  } finally {
    if (activeCallId === thisCallId) {
      acceptingCall = false;
    }
  }
}

async function handleCallAnswered(data) {
  if (
    !data ||
    !activeCallId ||
    String(data.callId) !== String(activeCallId) ||
    normalizeCallUserId(data.fromUserId) !== normalizeCallUserId(targetUserId) ||
    !isValidCallDescription(data.answer, 'answer') ||
    !peerConnection
  ) {
    return;
  }

  const thisCallId = activeCallId;
  const connection = peerConnection;

  try {
    await connection.setRemoteDescription(new RTCSessionDescription(data.answer));

    if (activeCallId !== thisCallId || peerConnection !== connection) {
      return;
    }

    await drainIceCandidateQueue(thisCallId, connection);
    setCallStatus('Menghubungkan...');
  } catch (error) {
    console.error('Gagal memasang remote description:', error);
    if (activeCallId === thisCallId) {
      cleanupCall(false);
    }
  }
}

async function handleIceCandidate(data) {
  if (
    !data ||
    !data.callId ||
    !data.candidate
  ) {
    return;
  }

  const messageCallId = String(data.callId);
  const senderId = normalizeCallUserId(data.fromUserId);

  if (!activeCallId) {
    rememberIceBeforeOffer(data);
    return;
  }

  if (
    messageCallId !== String(activeCallId) ||
    senderId !== normalizeCallUserId(targetUserId)
  ) {
    return;
  }

  if (iceCandidateQueue.length >= MAX_ICE_CANDIDATES) {
    return;
  }

  if (!peerConnection || !peerConnection.remoteDescription) {
    queueIceCandidate(data.candidate);
    return;
  }

  try {
    await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
  } catch (error) {
    console.warn('Error kandidat ICE:', error);
  }
}

// ==========================================================
// CHAT FILE INPUT
// ==========================================================
function isValidMediaFile(file) {
  if (!file) return false;

  const validType =
    file.type.startsWith('image/') ||
    file.type.startsWith('audio/') ||
    file.type === 'application/pdf' || 
    file.type.startsWith('application/vnd.openxmlformats-officedocument') || 
    file.type.startsWith('text/'); 

  return validType && file.size <= 10 * 1024 * 1024;
}

const chatFileInput = document.getElementById('chat-file-input');
if (chatFileInput) {
  chatFileInput.addEventListener('change', async function () {
    const file = this.files && this.files[0];
    if (!file) return;

    if (!currentUser) {
      alert('Silakan login terlebih dahulu!');
      this.value = '';
      return;
    }

    if (!isValidMediaFile(file)) {
      alert('File harus berupa gambar atau audio dan maksimal 10MB.');
      this.value = '';
      return;
    }

    const formData = new FormData();
    formData.append('media', file);
    formData.append(
      'client_time',
      new Date().toLocaleTimeString('id-ID', {
        hour: '2-digit',
        minute: '2-digit'
      })
    );

    try {
      const response = await apiFetch('/api/send-message', {
        method: 'POST',
        body: formData
      });

      const data = await parseJsonResponse(response);

      if (!response.ok) {
        alert(data.error || 'Gagal mengunggah media.');
      }
    } catch (error) {
      console.error('Upload media gagal:', error);
      alert('Terjadi kesalahan jaringan.');
    } finally {
      this.value = '';
    }
  });
}

// ==========================================
// EDIT PROFILE LOGIC (Name & Birthdate)
// ==========================================
function openEditProfileModal() {
  const modal = document.getElementById('edit-profile-modal');
  if (!modal) return;

  const nameInput = document.getElementById('edit-profile-name');
  const bdayInput = document.getElementById('edit-profile-birthdate');

  if (nameInput && currentUser) nameInput.value = currentUser.name || '';
  if (bdayInput && currentUser) bdayInput.value = currentUser.birthdate || '';

  modal.classList.remove('hidden');
}

function closeEditProfileModal() {
  const modal = document.getElementById('edit-profile-modal');
  if (modal) modal.classList.add('hidden');
}

async function handleUpdateProfile(event) {
  event.preventDefault();

  if (!currentUser) {
    alert('Silakan login terlebih dahulu!');
    return;
  }

  const name = document.getElementById('edit-profile-name')?.value.trim() || '';
  const birthdate = document.getElementById('edit-profile-birthdate')?.value || '';

  if (!name) {
    alert('Nama profil tidak boleh kosong.');
    return;
  }

  try {
    const response = await apiFetch('/api/update-profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, birthdate })
    });

    const data = await parseJsonResponse(response);

    if (response.ok) {
      alert(data.message || 'Profil berhasil diperbarui.');
      currentUser = data.user;
      localStorage.setItem(STORAGE_KEYS.user, JSON.stringify(currentUser));
      updateUserInterface();
      closeEditProfileModal();
    } else {
      alert(data.error || 'Gagal memperbarui profil.');
    }
  } catch (error) {
    console.error('Error update profile:', error);
    alert('Terjadi kesalahan jaringan.');
  }
}

// ==========================================================
// INITIALIZE
// ==========================================================
window.addEventListener('DOMContentLoaded', () => {
  applySavedTheme();

  if (currentUser && localStorage.getItem(STORAGE_KEYS.token)) {
    updateUserInterface();
    connectAuthenticatedSocket();
  } else {
    showAuthScreen();
  }
});

if (window.location.search.includes('phone=') || window.location.search.includes('password=')) {
  window.history.replaceState({}, document.title, window.location.pathname);
}

registerServiceWorker();