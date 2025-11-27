// Family Game Night - WebSocket Server
// Run with: node server.js

const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// Game state storage
const rooms = new Map();

// Room structure:
// {
//   code: string,
//   host: socketId,
//   players: Map<playerId, {id, name, avatar, socketId, score}>,
//   gameState: 'LOBBY' | 'PLAYING' | 'ROUND_END',
//   currentGame: 'trivia' | 'draw' | 'price',
//   currentQuestion: object,
//   questionNumber: number,
//   buzzedPlayer: string | null,
//   answers: Map<playerId, answer>
// }

// Trivia questions database
const triviaQuestions = [
  { q: "What year did the first iPhone launch?", a: "2007", choices: ["2005", "2007", "2009", "2010"] },
  { q: "Which planet is closest to the Sun?", a: "Mercury", choices: ["Venus", "Mercury", "Mars", "Earth"] },
  { q: "Who painted the Mona Lisa?", a: "Leonardo da Vinci", choices: ["Michelangelo", "Leonardo da Vinci", "Raphael", "Donatello"] },
  { q: "What is the capital of Australia?", a: "Canberra", choices: ["Sydney", "Melbourne", "Canberra", "Brisbane"] },
  { q: "How many hearts does an octopus have?", a: "3", choices: ["1", "2", "3", "4"] },
  { q: "What is the smallest country in the world?", a: "Vatican City", choices: ["Monaco", "Vatican City", "San Marino", "Liechtenstein"] },
  { q: "Which element has the chemical symbol 'Au'?", a: "Gold", choices: ["Silver", "Gold", "Copper", "Aluminum"] },
  { q: "How many strings does a standard guitar have?", a: "6", choices: ["4", "5", "6", "7"] },
  { q: "What is the tallest mountain in the world?", a: "Mount Everest", choices: ["K2", "Mount Everest", "Kilimanjaro", "Denali"] },
  { q: "What year did World War II end?", a: "1945", choices: ["1943", "1944", "1945", "1946"] }
];

// Generate room code
function generateRoomCode() {
  const adjectives = ['COOL', 'FAST', 'MEGA', 'EPIC', 'WILD', 'FIRE', 'STAR', 'BOLT', 'DASH', 'ZOOM'];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const num = Math.floor(1000 + Math.random() * 9000);
  return `${adj}-${num}`;
}

// Create new room
function createRoom(hostSocketId) {
  const code = generateRoomCode();
  const room = {
    code,
    host: hostSocketId,
    players: new Map(),
    gameState: 'LOBBY',
    currentGame: null,
    currentQuestion: null,
    questionNumber: 0,
    buzzedPlayer: null,
    answers: new Map(),
    questionStartTime: null
  };
  rooms.set(code, room);
  return room;
}

// Get random trivia questions
function getRandomQuestions(count = 5) {
  const shuffled = [...triviaQuestions].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // TV Display creates a room
  socket.on('create_room', (callback) => {
    const room = createRoom(socket.id);
    socket.join(room.code);
    console.log('Room created:', room.code);
    
    if (callback) {
      callback({ success: true, roomCode: room.code });
    }
  });

  // Player joins room
  socket.on('join_room', (data) => {
    const { roomCode, playerId, playerName, avatar } = data;
    const room = rooms.get(roomCode.toUpperCase());
    
    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }

    const player = {
      id: playerId,
      name: playerName,
      avatar: avatar || '🎮',
      socketId: socket.id,
      score: 0
    };

    room.players.set(playerId, player);
    socket.join(roomCode);
    
    console.log(`Player ${playerName} joined room ${roomCode}`);

    // Notify TV and other players
    io.to(room.host).emit('player_joined', player);
    io.to(roomCode).emit('player_list', Array.from(room.players.values()));
    
    socket.emit('joined_room', { 
      success: true, 
      roomCode,
      players: Array.from(room.players.values())
    });
  });

  // Start game
  socket.on('start_game', (data) => {
    const { roomCode, game } = data;
    const room = rooms.get(roomCode);
    
    if (!room || room.host !== socket.id) {
      socket.emit('error', { message: 'Not authorized' });
      return;
    }

    room.currentGame = game;
    room.gameState = 'PLAYING';
    room.questionNumber = 0;
    
    // Initialize scores
    room.players.forEach(player => player.score = 0);

    io.to(roomCode).emit('game_started', { game });
    
    // Start first question after a delay
    setTimeout(() => {
      nextQuestion(roomCode);
    }, 2000);
  });

  // Load next question
  function nextQuestion(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;

    room.questionNumber++;
    
    if (room.questionNumber > 5) {
      // End round
      room.gameState = 'ROUND_END';
      const leaderboard = Array.from(room.players.values())
        .sort((a, b) => b.score - a.score);
      
      io.to(roomCode).emit('round_end', { leaderboard });
      return;
    }

    // Get random question
    const question = getRandomQuestions(1)[0];
    room.currentQuestion = question;
    room.buzzedPlayer = null;
    room.answers.clear();
    room.questionStartTime = Date.now();

    // Send to TV
    io.to(room.host).emit('new_question', {
      questionNumber: room.questionNumber,
      question
    });

    // Send to players (without answer)
    room.players.forEach(player => {
      io.to(player.socketId).emit('new_question', {
        questionNumber: room.questionNumber,
        question: {
          q: question.q,
          choices: question.choices
        }
      });
    });
  }

  // Player buzzes in
  socket.on('buzz_in', (data) => {
    const { playerId } = data;
    
    // Find room with this player
    let room = null;
    let roomCode = null;
    for (const [code, r] of rooms.entries()) {
      if (r.players.has(playerId)) {
        room = r;
        roomCode = code;
        break;
      }
    }

    if (!room || room.buzzedPlayer) return;

    room.buzzedPlayer = playerId;
    const player = room.players.get(playerId);

    // Notify everyone
    io.to(roomCode).emit('player_buzzed', { 
      playerId, 
      playerName: player.name 
    });
    
    // Tell TV
    io.to(room.host).emit('player_buzzed', { 
      playerId, 
      playerName: player.name 
    });
  });

  // Player submits answer
  socket.on('submit_answer', (data) => {
    const { playerId, answer } = data;
    
    // Find room
    let room = null;
    let roomCode = null;
    for (const [code, r] of rooms.entries()) {
      if (r.players.has(playerId)) {
        room = r;
        roomCode = code;
        break;
      }
    }

    if (!room || !room.currentQuestion) return;

    const player = room.players.get(playerId);
    const correct = answer === room.currentQuestion.a;
    
    // Calculate points based on time (faster = more points)
    const timeElapsed = Date.now() - room.questionStartTime;
    const timeBonus = Math.max(0, 15000 - timeElapsed) / 1000;
    const points = correct ? Math.floor(100 + (timeBonus * 10)) : 0;
    
    if (correct) {
      player.score += points;
    }

    room.answers.set(playerId, { answer, correct, points });

    // Send feedback to player
    socket.emit('answer_result', { 
      correct, 
      points,
      correctAnswer: room.currentQuestion.a,
      totalScore: player.score
    });

    // Notify TV
    io.to(room.host).emit('answer_submitted', {
      playerId,
      playerName: player.name,
      correct,
      points,
      answer
    });

    // If all players answered or buzzed player answered, move to next
    if (room.buzzedPlayer === playerId || room.answers.size === room.players.size) {
      setTimeout(() => {
        nextQuestion(roomCode);
      }, 3000);
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    
    // Remove player from rooms
    for (const [code, room] of rooms.entries()) {
      if (room.host === socket.id) {
        // Host left, notify players and close room
        io.to(code).emit('room_closed');
        rooms.delete(code);
        console.log('Room closed:', code);
      } else {
        // Check if player left
        for (const [playerId, player] of room.players.entries()) {
          if (player.socketId === socket.id) {
            room.players.delete(playerId);
            io.to(room.host).emit('player_left', { playerId });
            console.log(`Player ${player.name} left room ${code}`);
            break;
          }
        }
      }
    }
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    rooms: rooms.size,
    timestamp: new Date().toISOString()
  });
});

// Get room info (for debugging)
app.get('/rooms', (req, res) => {
  const roomList = Array.from(rooms.entries()).map(([code, room]) => ({
    code,
    players: room.players.size,
    gameState: room.gameState,
    currentGame: room.currentGame
  }));
  res.json(roomList);
});

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`
  🎮 Family Game Night Server Running!
  
  Port: ${PORT}
  WebSocket: ws://localhost:${PORT}
  Health: http://localhost:${PORT}/health
  
  Ready for game night! 🚀
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});