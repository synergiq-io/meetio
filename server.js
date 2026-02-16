const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for presentation uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'slide-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB total
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    if (extname) {
      return cb(null, true);
    }
    cb(new Error('Only image files (JPG, PNG, GIF) are allowed!'));
  }
});

// Serve static files
app.use(express.static('public'));
app.use('/uploads', express.static(uploadsDir));

// Upload endpoint for presentation slides
app.post('/api/upload-presentation', upload.array('slides', 100), (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, error: 'No files uploaded' });
    }

    const slides = req.files.map((file, index) => ({
      url: `/uploads/${file.filename}`,
      filename: file.filename,
      index: index
    }));

    const notes = req.body.notes ? JSON.parse(req.body.notes) : [];
    
    res.json({
      success: true,
      presentation: {
        slides: slides,
        notes: notes
      }
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Handle room URLs
app.get('/room/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Store rooms with user info and meeting state
const rooms = new Map();

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join-room', (roomId, userId, userName) => {
    socket.join(roomId);
    
    // Initialize room if it doesn't exist
    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        users: new Map(),
        owner: socket.id,
        locked: false,
        createdAt: Date.now()
      });
      // Notify first user they are the owner
      socket.emit('you-are-owner');
    }

    const room = rooms.get(roomId);
    
    // Add user to room with name
    room.users.set(socket.id, { userId, userName });

    // Get existing users in room
    const existingUsers = Array.from(room.users.entries())
      .filter(([id]) => id !== socket.id)
      .map(([socketId, user]) => ({ socketId, userName: user.userName }));

    // Send existing users to new user
    socket.emit('existing-users', existingUsers);

    // Notify other users
    socket.to(roomId).emit('user-connected', { socketId: socket.id, userId, userName });
    console.log(`${userName} joined room ${roomId}`);

    // Handle WebRTC signaling with user names
    socket.on('offer', (offer, targetSocketId) => {
      const user = room.users.get(socket.id);
      io.to(targetSocketId).emit('offer', offer, socket.id, user.userName);
    });

    socket.on('answer', (answer, targetSocketId) => {
      io.to(targetSocketId).emit('answer', answer, socket.id);
    });

    socket.on('ice-candidate', (candidate, targetSocketId) => {
      io.to(targetSocketId).emit('ice-candidate', candidate, socket.id);
    });

    // Handle chat messages
    socket.on('chat-message', (message) => {
      socket.to(roomId).emit('chat-message', message);
    });

    // Owner control: Lock meeting
    socket.on('lock-meeting', () => {
      if (socket.id === room.owner) {
        room.locked = true;
        io.to(roomId).emit('meeting-locked');
        console.log(`Meeting ${roomId} locked by owner`);
      }
    });

    // Owner control: Unlock meeting
    socket.on('unlock-meeting', () => {
      if (socket.id === room.owner) {
        room.locked = false;
        io.to(roomId).emit('meeting-unlocked');
        console.log(`Meeting ${roomId} unlocked by owner`);
      }
    });

    // Owner control: End meeting for all
    socket.on('end-meeting', () => {
      if (socket.id === room.owner) {
        io.to(roomId).emit('meeting-ended');
        console.log(`Meeting ${roomId} ended by owner`);
        
        // Clean up room
        const socketsInRoom = io.sockets.adapter.rooms.get(roomId);
        if (socketsInRoom) {
          socketsInRoom.forEach(socketId => {
            io.sockets.sockets.get(socketId)?.disconnect(true);
          });
        }
        rooms.delete(roomId);
      }
    });

    // Presentation control: Start presentation
    socket.on('start-presentation', (presentation) => {
      if (socket.id === room.owner) {
        room.presentation = presentation;
        room.currentSlide = 0;
        socket.to(roomId).emit('presentation-started', {
          slides: presentation.slides,
          currentSlide: 0,
          totalSlides: presentation.slides.length
        });
        console.log(`Presentation started in room ${roomId}`);
      }
    });

    // Presentation control: Change slide
    socket.on('change-slide', (slideIndex) => {
      if (socket.id === room.owner && room.presentation) {
        room.currentSlide = slideIndex;
        socket.to(roomId).emit('slide-changed', {
          slideIndex: slideIndex,
          slideUrl: room.presentation.slides[slideIndex].url
        });
        console.log(`Slide changed to ${slideIndex} in room ${roomId}`);
      }
    });

    // Presentation control: End presentation
    socket.on('end-presentation', () => {
      if (socket.id === room.owner) {
        delete room.presentation;
        delete room.currentSlide;
        socket.to(roomId).emit('presentation-ended');
        console.log(`Presentation ended in room ${roomId}`);
      }
    });

    socket.on('disconnect', () => {
      if (rooms.has(roomId)) {
        const user = room.users.get(socket.id);
        room.users.delete(socket.id);
        
        // If owner left and there are still users, assign new owner
        if (socket.id === room.owner && room.users.size > 0) {
          const newOwner = Array.from(room.users.keys())[0];
          room.owner = newOwner;
          io.to(newOwner).emit('you-are-owner');
          console.log(`New owner assigned: ${newOwner}`);
        }
        
        // Delete room if empty
        if (room.users.size === 0) {
          rooms.delete(roomId);
        }
        
        if (user) {
          socket.to(roomId).emit('user-disconnected', { 
            socketId: socket.id, 
            userId: user.userId, 
            userName: user.userName 
          });
          console.log(`${user.userName} left room ${roomId}`);
        }
      }
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
