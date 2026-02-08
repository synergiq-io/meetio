// Configuration
const configuration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// State
let socket;
let localStream;
let peers = {};
let roomId;
let userId;
let userName;
let isVideoEnabled = true;
let isAudioEnabled = true;
let isChatOpen = false;
let unreadMessages = 0;
let isOwner = false;
let meetingLocked = false;
let meetingStartTime;
let timerInterval;

// DOM Elements - Join Screen
const joinScreen = document.getElementById('join-screen');
const videoScreen = document.getElementById('video-screen');
const roomIdInput = document.getElementById('room-id-input');
const userNameInput = document.getElementById('user-name-input');
const joinBtn = document.getElementById('join-btn');
const joinBtnText = document.getElementById('join-btn-text');
const joinBtnIcon = document.getElementById('join-btn-icon');
const roomIdGroup = document.getElementById('room-id-group');
const meetingInfo = document.getElementById('meeting-info');
const displayRoomId = document.getElementById('display-room-id');

// DOM Elements - Video Screen
const videosGrid = document.getElementById('videos-grid');
const meetingLink = document.getElementById('meeting-link');
const copyLinkBtn = document.getElementById('copy-link-btn');
const topRoomId = document.getElementById('top-room-id');
const meetingTimer = document.getElementById('meeting-timer');

// DOM Elements - Owner Controls
const ownerControls = document.getElementById('owner-controls');
const lockMeetingBtn = document.getElementById('lock-meeting-btn');
const endMeetingBtn = document.getElementById('end-meeting-btn');

// DOM Elements - Meeting Ended
const meetingEndedOverlay = document.getElementById('meeting-ended-overlay');
const returnHomeBtn = document.getElementById('return-home-btn');

// DOM Elements - Controls
const toggleVideoBtn = document.getElementById('toggle-video');
const toggleAudioBtn = document.getElementById('toggle-audio');
const shareScreenBtn = document.getElementById('share-screen');
const leaveRoomBtn = document.getElementById('leave-room');
const toggleChatBtn = document.getElementById('toggle-chat');
const participantsBtn = document.getElementById('participants-btn');
const participantsCount = document.getElementById('participants-count');

// DOM Elements - Chat
const chatSidebar = document.getElementById('chat-sidebar');
const closeChatBtn = document.getElementById('close-chat');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const sendMessageBtn = document.getElementById('send-message');
const unreadBadge = document.getElementById('unread-badge');

// Initialize
document.addEventListener('DOMContentLoaded', initializeApp);

function initializeApp() {
    // Check for room ID in URL
    const urlPath = window.location.pathname;
    const match = urlPath.match(/\/room\/([A-Za-z0-9]+)/);
    
    if (match) {
        roomId = match[1];
        roomIdInput.value = roomId;
        roomIdGroup.style.display = 'none';
        meetingInfo.classList.remove('hidden');
        displayRoomId.textContent = roomId;
        userNameInput.focus();
    }

    // Event Listeners
    joinBtn.addEventListener('click', joinRoom);
    toggleVideoBtn.addEventListener('click', toggleVideo);
    toggleAudioBtn.addEventListener('click', toggleAudio);
    shareScreenBtn.addEventListener('click', shareScreen);
    leaveRoomBtn.addEventListener('click', leaveRoom);
    toggleChatBtn.addEventListener('click', toggleChat);
    closeChatBtn.addEventListener('click', toggleChat);
    sendMessageBtn.addEventListener('click', sendChatMessage);
    chatInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendChatMessage();
    });
    copyLinkBtn.addEventListener('click', copyMeetingLink);
    lockMeetingBtn.addEventListener('click', toggleMeetingLock);
    endMeetingBtn.addEventListener('click', endMeetingForAll);
    returnHomeBtn.addEventListener('click', () => window.location.href = '/');
}

async function joinRoom() {
    userName = userNameInput.value.trim();
    if (!userName) {
        alert('Please enter your name');
        userNameInput.focus();
        return;
    }

    if (!roomId) {
        roomId = roomIdInput.value.trim() || generateRoomId();
    }
    
    userId = userName + '-' + Math.random().toString(36).substr(2, 9);

    joinBtn.disabled = true;
    joinBtnIcon.textContent = '⏳';
    joinBtnText.textContent = 'Joining...';

    try {
        console.log('Requesting media access...');
        localStream = await navigator.mediaDevices.getUserMedia({
            video: { ideal: { width: 1280, height: 720 } },
            audio: true
        });
        console.log('Media access granted');

        console.log('Connecting to server...');
        socket = io();
        
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000);
            socket.on('connect', () => {
                clearTimeout(timeout);
                console.log('Connected to server');
                resolve();
            });
            socket.on('connect_error', (error) => {
                clearTimeout(timeout);
                console.error('Connection error:', error);
                reject(error);
            });
        });

        setupSocketListeners();

        console.log('Joining room:', roomId);
        socket.emit('join-room', roomId, userId, userName);

        joinScreen.classList.remove('active');
        videoScreen.classList.add('active');

        const meetingUrl = `${window.location.origin}/room/${roomId}`;
        meetingLink.value = meetingUrl;
        topRoomId.textContent = roomId;
        window.history.pushState({}, '', `/room/${roomId}`);

        console.log('Adding local video');
        addLocalVideo();

        console.log('Successfully joined room');

    } catch (error) {
        console.error('Error joining room:', error);
        joinBtn.disabled = false;
        joinBtnIcon.textContent = '🎥';
        joinBtnText.textContent = 'Join Meeting';
        
        if (error.name === 'NotAllowedError') {
            alert('Camera/microphone access denied. Please allow permissions and try again.');
        } else if (error.name === 'NotFoundError') {
            alert('No camera or microphone found. Please connect a device and try again.');
        } else {
            alert('Failed to join meeting: ' + error.message);
        }
        
        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
            localStream = null;
        }
        if (socket) {
            socket.disconnect();
            socket = null;
        }
    }
}

function startMeetingTimer() {
    meetingStartTime = Date.now();
    timerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - meetingStartTime) / 1000);
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        meetingTimer.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }, 1000);
}

function setupSocketListeners() {
    socket.on('you-are-owner', () => {
        console.log('You are the meeting owner');
        isOwner = true;
        ownerControls.classList.remove('hidden');
        startMeetingTimer();
    });

    socket.on('existing-users', (existingUsers) => {
        console.log('Existing users:', existingUsers);
        existingUsers.forEach(user => {
            createPeerConnection(user.socketId, user.userName, true);
        });
        updateParticipantCount();
    });

    socket.on('user-connected', (newUser) => {
        console.log('User connected:', newUser.userName);
        addSystemMessage(`${newUser.userName} joined the meeting`);
        updateParticipantCount();
    });

    socket.on('offer', async (offer, fromSocketId, fromUserName) => {
        console.log('Received offer from:', fromUserName);
        const peer = createPeerConnection(fromSocketId, fromUserName, false);
        await peer.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        socket.emit('answer', answer, fromSocketId);
    });

    socket.on('answer', async (answer, fromSocketId) => {
        console.log('Received answer from:', fromSocketId);
        const peer = peers[fromSocketId]?.connection;
        if (peer) {
            await peer.setRemoteDescription(new RTCSessionDescription(answer));
        }
    });

    socket.on('ice-candidate', async (candidate, fromSocketId) => {
        const peer = peers[fromSocketId]?.connection;
        if (peer) {
            await peer.addIceCandidate(new RTCIceCandidate(candidate));
        }
    });

    socket.on('user-disconnected', (disconnectedUser) => {
        console.log('User disconnected:', disconnectedUser.userName);
        addSystemMessage(`${disconnectedUser.userName} left the meeting`);
        removeVideo(disconnectedUser.socketId);
        updateParticipantCount();
    });

    socket.on('chat-message', (message) => {
        addChatMessage(message.userName, message.text, message.time, false);
        if (!isChatOpen) {
            unreadMessages++;
            updateUnreadBadge();
        }
    });

    socket.on('meeting-locked', () => {
        meetingLocked = true;
        if (isOwner && lockMeetingBtn) {
            lockMeetingBtn.classList.add('locked');
            const icon = lockMeetingBtn.querySelector('.icon');
            if (icon) icon.textContent = '🔒';
        }
    });

    socket.on('meeting-unlocked', () => {
        meetingLocked = false;
        if (isOwner && lockMeetingBtn) {
            lockMeetingBtn.classList.remove('locked');
            const icon = lockMeetingBtn.querySelector('.icon');
            if (icon) icon.textContent = '🔓';
        }
    });

    socket.on('meeting-ended', () => {
        console.log('Meeting ended by owner');
        showMeetingEnded();
    });
}

function createPeerConnection(socketId, peerUserName, isInitiator) {
    console.log('Creating peer connection with:', peerUserName);
    const peer = new RTCPeerConnection(configuration);
    peers[socketId] = { connection: peer, userName: peerUserName };

    localStream.getTracks().forEach(track => peer.addTrack(track, localStream));

    peer.ontrack = (event) => {
        console.log('Received track from:', peerUserName);
        addVideoStream(socketId, peerUserName, event.streams[0]);
    };

    peer.onicecandidate = (event) => {
        if (event.candidate) socket.emit('ice-candidate', event.candidate, socketId);
    };

    peer.onconnectionstatechange = () => {
        if (['disconnected', 'failed', 'closed'].includes(peer.connectionState)) {
            removeVideo(socketId);
        }
    };

    if (isInitiator) {
        peer.onnegotiationneeded = async () => {
            try {
                const offer = await peer.createOffer();
                await peer.setLocalDescription(offer);
                socket.emit('offer', offer, socketId);
            } catch (error) {
                console.error('Error creating offer:', error);
            }
        };
    }

    return peer;
}

function addLocalVideo() {
    const tile = document.createElement('div');
    tile.className = 'video-tile';
    tile.id = 'local-video-tile';

    const video = document.createElement('video');
    video.srcObject = localStream;
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;

    const overlay = document.createElement('div');
    overlay.className = 'video-tile-overlay';
    overlay.textContent = `${userName} (You)`;

    tile.appendChild(video);
    tile.appendChild(overlay);
    videosGrid.appendChild(tile);
    updateGridLayout();
}

function addVideoStream(socketId, peerUserName, stream) {
    if (document.getElementById(`video-${socketId}`)) return;

    const tile = document.createElement('div');
    tile.className = 'video-tile';
    tile.id = `video-${socketId}`;

    const video = document.createElement('video');
    video.srcObject = stream;
    video.autoplay = true;
    video.playsInline = true;

    const overlay = document.createElement('div');
    overlay.className = 'video-tile-overlay';
    overlay.textContent = peerUserName;

    tile.appendChild(video);
    tile.appendChild(overlay);
    videosGrid.appendChild(tile);
    updateGridLayout();
}

function removeVideo(socketId) {
    const tile = document.getElementById(`video-${socketId}`);
    if (tile) tile.remove();
    if (peers[socketId]) {
        peers[socketId].connection.close();
        delete peers[socketId];
    }
    updateGridLayout();
}

function updateGridLayout() {
    videosGrid.setAttribute('data-count', videosGrid.children.length);
}

function updateParticipantCount() {
    participantsCount.textContent = Object.keys(peers).length + 1;
}

function toggleVideo() {
    isVideoEnabled = !isVideoEnabled;
    localStream.getVideoTracks().forEach(track => track.enabled = isVideoEnabled);
    toggleVideoBtn.classList.toggle('active', !isVideoEnabled);
    toggleVideoBtn.querySelector('.label').textContent = isVideoEnabled ? 'Stop Video' : 'Start Video';
}

function toggleAudio() {
    isAudioEnabled = !isAudioEnabled;
    localStream.getAudioTracks().forEach(track => track.enabled = isAudioEnabled);
    toggleAudioBtn.classList.toggle('active', !isAudioEnabled);
    toggleAudioBtn.querySelector('.label').textContent = isAudioEnabled ? 'Mute' : 'Unmute';
    const localOverlay = document.querySelector('#local-video-tile .video-tile-overlay');
    if (localOverlay) localOverlay.classList.toggle('muted', !isAudioEnabled);
}

async function shareScreen() {
    try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenTrack = screenStream.getVideoTracks()[0];

        Object.values(peers).forEach(peerObj => {
            const sender = peerObj.connection.getSenders().find(s => s.track?.kind === 'video');
            if (sender) sender.replaceTrack(screenTrack);
        });

        const localVideo = document.querySelector('#local-video-tile video');
        if (localVideo) localVideo.srcObject = screenStream;

        screenTrack.onended = () => {
            const videoTrack = localStream.getVideoTracks()[0];
            Object.values(peers).forEach(peerObj => {
                const sender = peerObj.connection.getSenders().find(s => s.track?.kind === 'video');
                if (sender) sender.replaceTrack(videoTrack);
            });
            if (localVideo) localVideo.srcObject = localStream;
        };
    } catch (error) {
        console.error('Error sharing screen:', error);
    }
}

function toggleChat() {
    isChatOpen = !isChatOpen;
    chatSidebar.classList.toggle('open', isChatOpen);
    toggleChatBtn.classList.toggle('active', isChatOpen);
    if (isChatOpen) {
        unreadMessages = 0;
        updateUnreadBadge();
        chatInput.focus();
    }
}

function sendChatMessage() {
    const text = chatInput.value.trim();
    if (!text) return;

    const message = {
        userName: userName,
        text: text,
        time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    };

    socket.emit('chat-message', message);
    addChatMessage(message.userName, message.text, message.time, true);
    chatInput.value = '';
    chatInput.focus();
}

function addChatMessage(senderName, text, time, isOwn) {
    const messageDiv = document.createElement('div');
    messageDiv.className = 'chat-message' + (isOwn ? ' own' : '');

    const headerDiv = document.createElement('div');
    headerDiv.className = 'chat-message-header';

    const senderSpan = document.createElement('span');
    senderSpan.className = 'chat-sender';
    senderSpan.textContent = isOwn ? 'You' : senderName;

    const timeSpan = document.createElement('span');
    timeSpan.className = 'chat-time';
    timeSpan.textContent = time;

    headerDiv.appendChild(senderSpan);
    headerDiv.appendChild(timeSpan);

    const textDiv = document.createElement('div');
    textDiv.className = 'chat-text';
    textDiv.textContent = text;

    messageDiv.appendChild(headerDiv);
    messageDiv.appendChild(textDiv);
    chatMessages.appendChild(messageDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addSystemMessage(text) {
    const messageDiv = document.createElement('div');
    messageDiv.style.textAlign = 'center';
    messageDiv.style.opacity = '0.7';
    messageDiv.style.fontStyle = 'italic';
    messageDiv.style.fontSize = '13px';
    messageDiv.style.padding = '8px';
    messageDiv.textContent = text;
    chatMessages.appendChild(messageDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function updateUnreadBadge() {
    if (unreadMessages > 0) {
        unreadBadge.textContent = unreadMessages;
        unreadBadge.classList.remove('hidden');
    } else {
        unreadBadge.classList.add('hidden');
    }
}

function toggleMeetingLock() {
    if (!isOwner) return;
    meetingLocked = !meetingLocked;
    socket.emit(meetingLocked ? 'lock-meeting' : 'unlock-meeting');
    lockMeetingBtn.classList.toggle('locked', meetingLocked);
    const icon = lockMeetingBtn.querySelector('.icon');
    if (icon) icon.textContent = meetingLocked ? '🔒' : '🔓';
    addSystemMessage(meetingLocked ? 'Meeting locked by host' : 'Meeting unlocked by host');
}

function endMeetingForAll() {
    if (!isOwner) return;
    if (confirm('Are you sure you want to end this meeting for everyone?')) {
        socket.emit('end-meeting');
        showMeetingEnded();
    }
}

function showMeetingEnded() {
    if (meetingEndedOverlay) meetingEndedOverlay.classList.remove('hidden');
    if (localStream) localStream.getTracks().forEach(track => track.stop());
    Object.values(peers).forEach(peerObj => peerObj.connection?.close());
    peers = {};
    if (timerInterval) clearInterval(timerInterval);
}

function copyMeetingLink() {
    meetingLink.select();
    navigator.clipboard.writeText(meetingLink.value).then(() => {
        const originalHTML = copyLinkBtn.innerHTML;
        copyLinkBtn.innerHTML = '<span class="icon">✓</span> Copied!';
        copyLinkBtn.classList.add('copied');
        setTimeout(() => {
            copyLinkBtn.innerHTML = originalHTML;
            copyLinkBtn.classList.remove('copied');
        }, 2000);
    }).catch(err => console.error('Failed to copy:', err));
}

function leaveRoom() {
    if (confirm('Are you sure you want to leave this meeting?')) {
        if (localStream) localStream.getTracks().forEach(track => track.stop());
        Object.values(peers).forEach(peerObj => peerObj.connection?.close());
        peers = {};
        if (socket) socket.disconnect();
        if (timerInterval) clearInterval(timerInterval);
        window.location.href = '/';
    }
}

function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}
