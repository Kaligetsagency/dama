const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(cors());

// --- DATABASE SETUP (WAL Mode for Performance) ---
const db = new sqlite3.Database('./vuta_pumzi.db', (err) => {
    if (err) console.error(err.message);
    console.log('Connected to local database.');
    db.run('PRAGMA journal_mode = WAL;'); 
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT UNIQUE,
        password TEXT,
        real_balance INTEGER DEFAULT 0,
        demo_balance INTEGER DEFAULT 50000,
        username TEXT,
        elo INTEGER DEFAULT 1200
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        type TEXT,
        amount INTEGER,
        network TEXT,
        status TEXT,
        date DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS admin_wallet (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        balance INTEGER DEFAULT 0
    )`);
    db.run(`INSERT OR IGNORE INTO admin_wallet (id, balance) VALUES (1, 0)`);
});

const ADMIN_PIN = "2024";

// --- API ROUTES ---
app.post('/api/register', async (req, res) => {
    const { phone, password, username } = req.body;
    if (!phone || !password) return res.status(400).json({ error: 'Jaza nafasi zote' });
    const hashedPassword = await bcrypt.hash(password, 10);
    const userDisplay = username || `Player_${Math.floor(Math.random()*1000)}`;
    
    db.run(`INSERT INTO users (phone, password, username) VALUES (?, ?, ?)`, [phone, hashedPassword, userDisplay], function(err) {
        if (err) return res.status(400).json({ error: 'Namba hii imesajiliwa tayari.' });
        res.json({ success: true, userId: this.lastID });
    });
});

app.post('/api/login', (req, res) => {
    const { phone, password } = req.body;
    db.get(`SELECT * FROM users WHERE phone = ?`, [phone], async (err, user) => {
        if (err || !user) return res.status(400).json({ error: 'Taarifa sio sahihi.' });
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return res.status(400).json({ error: 'Taarifa sio sahihi.' });
        res.json({ success: true, user: { id: user.id, phone: user.phone, username: user.username, real_balance: user.real_balance, demo_balance: user.demo_balance, elo: user.elo } });
    });
});

app.get('/api/user-data/:id', (req, res) => {
    const userId = req.params.id;
    db.get(`SELECT real_balance, demo_balance, elo FROM users WHERE id = ?`, [userId], (err, row) => {
        if (!row) return res.status(404).json({});
        db.all(`SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 10`, [userId], (err, txs) => {
            res.json({ real_balance: row.real_balance, demo_balance: row.demo_balance, elo: row.elo, transactions: txs });
        });
    });
});

app.post('/api/deposit', (req, res) => {
    const { userId, amount, network } = req.body;
    db.run(`UPDATE users SET real_balance = real_balance + ? WHERE id = ?`, [amount, userId], (err) => {
        db.run(`INSERT INTO transactions (user_id, type, amount, network, status) VALUES (?, 'DEPOSIT', ?, ?, 'SUCCESS')`, [userId, amount, network]);
        res.json({ success: true, message: 'Muamala Umekamilika' });
    });
});

app.post('/api/withdraw', (req, res) => {
    const { userId, amount, network } = req.body;
    db.get(`SELECT real_balance FROM users WHERE id = ?`, [userId], (err, row) => {
        if (row.real_balance < amount) return res.status(400).json({ error: 'Salio halitoshi' });
        db.run(`UPDATE users SET real_balance = real_balance - ? WHERE id = ?`, [amount, userId], (err) => {
            db.run(`INSERT INTO transactions (user_id, type, amount, network, status) VALUES (?, 'WITHDRAW', ?, ?, 'PENDING')`, [userId, amount, network]);
            res.json({ success: true, message: 'Ombi limetumwa.' });
        });
    });
});

// --- GAME SERVER LOGIC ---
let openChallenges = []; 
const activeRooms = {};

function updateElo(winnerElo, loserElo) {
    const k = 32;
    const expectedWin = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
    const expectedLoss = 1 / (1 + Math.pow(10, (winnerElo - loserElo) / 400));
    return {
        newWinnerElo: Math.round(winnerElo + k * (1 - expectedWin)),
        newLoserElo: Math.round(loserElo + k * (0 - expectedLoss))
    };
}

io.on('connection', (socket) => {
    socket.emit('lobby_update', openChallenges.filter(c => !c.isPrivate));

    socket.on('create_challenge', (data) => {
        const { userId, username, stake, mode, isPrivate, elo } = data;
        const balCol = mode === 'real' ? 'real_balance' : 'demo_balance';
        
        db.get(`SELECT ${balCol} as bal FROM users WHERE id = ?`, [userId], (err, row) => {
            if (!row || row.bal < stake) return socket.emit('error', { message: 'Salio Halitoshi!' });

            const roomId = isPrivate ? Math.random().toString(36).substr(2, 5).toUpperCase() : 'pub_' + Date.now();
            db.run(`UPDATE users SET ${balCol} = ${balCol} - ? WHERE id = ?`, [stake, userId], (err) => {
                socket.join(roomId);
                socket.roomId = roomId;
                socket.userId = userId;
                
                const challenge = { roomId, hostId: socket.id, userId, hostName: username, stake: parseInt(stake), mode, isPrivate, elo };
                openChallenges.push(challenge);
                
                socket.emit('game_created', { roomId, isPrivate });
                if (!isPrivate) io.emit('lobby_update', openChallenges.filter(c => !c.isPrivate));
                if (mode === 'real') db.run(`INSERT INTO transactions (user_id, type, amount, status) VALUES (?, 'ENTRY_FEE', ?, 'PENDING')`, [userId, stake]);
            });
        });
    });

    socket.on('join_challenge', (data) => {
        const { userId, username, roomId, elo } = data;
        const challengeIndex = openChallenges.findIndex(c => c.roomId === roomId);
        
        if (challengeIndex === -1) return socket.emit('error', { message: 'Mechi haipatikani.' });
        const challenge = openChallenges[challengeIndex];
        if (challenge.userId == userId) return socket.emit('error', { message: 'Huwezi kucheza dhidi yako!' });

        const balCol = challenge.mode === 'real' ? 'real_balance' : 'demo_balance';

        db.get(`SELECT ${balCol} as bal FROM users WHERE id = ?`, [userId], (err, row) => {
            if (!row || row.bal < challenge.stake) return socket.emit('error', { message: 'Salio Halitoshi!' });

            openChallenges.splice(challengeIndex, 1);
            io.emit('lobby_update', openChallenges.filter(c => !c.isPrivate));

            db.run(`UPDATE users SET ${balCol} = ${balCol} - ? WHERE id = ?`, [challenge.stake, userId], (err) => {
                socket.join(roomId);
                socket.roomId = roomId;
                socket.userId = userId;

                activeRooms[roomId] = {
                    p1: { id: challenge.hostId, userId: challenge.userId, elo: challenge.elo },
                    p2: { id: socket.id, userId: userId, elo: elo },
                    stake: challenge.stake,
                    mode: challenge.mode
                };
                
                if (challenge.mode === 'real') db.run(`INSERT INTO transactions (user_id, type, amount, status) VALUES (?, 'ENTRY_FEE', ?, 'PENDING')`, [userId, challenge.stake]);

                io.to(roomId).emit('game_start', {
                    roomId,
                    players: { red: challenge.hostId, white: socket.id },
                    usernames: { red: challenge.hostName, white: username },
                    stake: challenge.stake
                });
            });
        });
    });

    socket.on('cancel_challenge', () => {
        const idx = openChallenges.findIndex(c => c.hostId === socket.id);
        if (idx !== -1) {
            const c = openChallenges[idx];
            const balCol = c.mode === 'real' ? 'real_balance' : 'demo_balance';
            openChallenges.splice(idx, 1);
            io.emit('lobby_update', openChallenges.filter(game => !game.isPrivate));
            db.run(`UPDATE users SET ${balCol} = ${balCol} + ? WHERE id = ?`, [c.stake, c.userId]);
            socket.emit('challenge_cancelled');
        }
    });

    socket.on('make_move', (data) => { if (socket.roomId) socket.to(socket.roomId).emit('opponent_move', data); });

    const handleGameOver = (roomId, winnerSocketId, reason) => {
        const room = activeRooms[roomId];
        if (!room || room.processed) return;
        room.processed = true;

        const isDraw = reason === 'draw';
        const balCol = room.mode === 'real' ? 'real_balance' : 'demo_balance';
        const totalPot = room.stake * 2;

        if (isDraw) {
            const platformFee = Math.floor(totalPot * 0.10);
            const refund = Math.floor((totalPot - platformFee) / 2);
            db.run(`UPDATE users SET ${balCol} = ${balCol} + ? WHERE id IN (?, ?)`, [refund, room.p1.userId, room.p2.userId]);
            if (room.mode === 'real') db.run(`UPDATE admin_wallet SET balance = balance + ? WHERE id = 1`, [platformFee]);
            io.to(roomId).emit('match_result', { isDraw: true, refund });
        } else {
            const winner = winnerSocketId === room.p1.id ? room.p1 : room.p2;
            const loser = winnerSocketId === room.p1.id ? room.p2 : room.p1;
            
            const platformFee = Math.floor(totalPot * 0.10); 
            const winnerTake = totalPot - platformFee;
            const newElos = updateElo(winner.elo, loser.elo);

            db.run(`UPDATE users SET ${balCol} = ${balCol} + ?, elo = ? WHERE id = ?`, [winnerTake, newElos.newWinnerElo, winner.userId]);
            db.run(`UPDATE users SET elo = ? WHERE id = ?`, [newElos.newLoserElo, loser.userId]);

            if (room.mode === 'real') {
                db.run(`UPDATE admin_wallet SET balance = balance + ? WHERE id = 1`, [platformFee]);
                db.run(`INSERT INTO transactions (user_id, type, amount, status) VALUES (?, 'PRIZE_PAYOUT', ?, 'SUCCESS')`, [winner.userId, winnerTake]);
            }

            io.to(roomId).emit('match_result', { isDraw: false, winnerId: winner.userId, payout: winnerTake, reason });
        }
        delete activeRooms[roomId];
    };

    socket.on('game_over', (data) => handleGameOver(socket.roomId, data.winner === 'me' ? socket.id : null, 'regular'));
    socket.on('timeout_loss', () => handleGameOver(socket.roomId, activeRooms[socket.roomId]?.p1.id === socket.id ? activeRooms[socket.roomId].p2.id : activeRooms[socket.roomId].p1.id, 'timeout'));
    
    socket.on('offer_draw', () => socket.to(socket.roomId).emit('draw_offered'));
    socket.on('accept_draw', () => handleGameOver(socket.roomId, null, 'draw'));

    socket.on('disconnect', () => {
        const idx = openChallenges.findIndex(c => c.hostId === socket.id);
        if (idx !== -1) {
            const c = openChallenges[idx];
            db.run(`UPDATE users SET ${c.mode === 'real' ? 'real_balance' : 'demo_balance'} = ${c.mode === 'real' ? 'real_balance' : 'demo_balance'} + ? WHERE id = ?`, [c.stake, c.userId]);
            openChallenges.splice(idx, 1);
            io.emit('lobby_update', openChallenges.filter(c => !c.isPrivate));
        }
        if (socket.roomId && activeRooms[socket.roomId] && !activeRooms[socket.roomId].processed) {
            const opponentId = activeRooms[socket.roomId].p1.id === socket.id ? activeRooms[socket.roomId].p2.id : activeRooms[socket.roomId].p1.id;
            handleGameOver(socket.roomId, opponentId, 'abandon');
        }
    });
});

const PORT = process.env.PORT || 7860;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));