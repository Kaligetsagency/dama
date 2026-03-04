const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const path = require('path');
const cors = require('cors');

const { createClient } = require('redis');
const { createAdapter } = require('@socket.io/redis-adapter');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(cors());

// ==========================================
// 1. REDIS SETUP (The "Shared Brain")
// ==========================================
let pubClient, subClient;

if (process.env.REDIS_URL) {
    pubClient = createClient({ url: process.env.REDIS_URL });
    subClient = pubClient.duplicate();

    Promise.all([pubClient.connect(), subClient.connect()]).then(() => {
        io.adapter(createAdapter(pubClient, subClient));
        console.log('✅ Connected to Redis: Servers are now completely STATELESS!');
    }).catch(err => console.error('❌ Redis Connection Error:', err));
} else {
    console.log('⚠️ No REDIS_URL found. Crashing, because Phase 3 requires Redis.');
    process.exit(1); // Force exit if Redis isn't there in Phase 3
}

// ==========================================
// 2. DATABASE SETUP (PostgreSQL via Railway)
// ==========================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

pool.connect().then(client => {
    console.log('✅ Connected to PostgreSQL database.');
    client.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            phone VARCHAR(20) UNIQUE,
            password TEXT,
            real_balance INTEGER DEFAULT 0,
            demo_balance INTEGER DEFAULT 50000,
            username TEXT,
            elo INTEGER DEFAULT 1200
        );
        CREATE TABLE IF NOT EXISTS transactions (
            id SERIAL PRIMARY KEY,
            user_id INTEGER,
            type TEXT,
            amount INTEGER,
            network TEXT,
            status TEXT,
            date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS admin_wallet (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            balance INTEGER DEFAULT 0
        );
        INSERT INTO admin_wallet (id, balance) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;
    `).then(() => {
        client.release();
    });
}).catch(err => console.error("❌ DB Error:", err.message));

// ==========================================
// 3. API ROUTES (Registration, Login, Wallet)
// ==========================================
// (Keeping these exact same as Phase 2 - they already use Postgres perfectly)
app.post('/api/register', async (req, res) => {
    const { phone, password, username } = req.body;
    if (!phone || !password) return res.status(400).json({ error: 'Jaza nafasi zote' });
    const hashedPassword = await bcrypt.hash(password, 10);
    const userDisplay = username || `Player_${Math.floor(Math.random()*1000)}`;
    try {
        const result = await pool.query(`INSERT INTO users (phone, password, username) VALUES ($1, $2, $3) RETURNING id`, [phone, hashedPassword, userDisplay]);
        res.json({ success: true, userId: result.rows[0].id });
    } catch (err) { return res.status(400).json({ error: 'Namba hii imesajiliwa tayari.' }); }
});

app.post('/api/login', async (req, res) => {
    const { phone, password } = req.body;
    try {
        const result = await pool.query(`SELECT * FROM users WHERE phone = $1`, [phone]);
        const user = result.rows[0];
        if (!user || !(await bcrypt.compare(password, user.password))) return res.status(400).json({ error: 'Taarifa sio sahihi.' });
        res.json({ success: true, user: { id: user.id, phone: user.phone, username: user.username, real_balance: user.real_balance, demo_balance: user.demo_balance, elo: user.elo } });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/user-data/:id', async (req, res) => {
    try {
        const userRes = await pool.query(`SELECT real_balance, demo_balance, elo FROM users WHERE id = $1`, [req.params.id]);
        if (userRes.rowCount === 0) return res.status(404).json({});
        const txsRes = await pool.query(`SELECT * FROM transactions WHERE user_id = $1 ORDER BY id DESC LIMIT 10`, [req.params.id]);
        res.json({ ...userRes.rows[0], transactions: txsRes.rows });
    } catch(err) { res.status(500).json({}); }
});

// ==========================================
// 4. GAME SERVER LOGIC (Stateless with Redis)
// ==========================================
function updateElo(winnerElo, loserElo) {
    const k = 32;
    const expectedWin = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
    const expectedLoss = 1 / (1 + Math.pow(10, (winnerElo - loserElo) / 400));
    return {
        newWinnerElo: Math.round(winnerElo + k * (1 - expectedWin)),
        newLoserElo: Math.round(loserElo + k * (0 - expectedLoss))
    };
}

// Helper to broadcast lobby directly from Redis
async function broadcastLobby() {
    const rawChallenges = await pubClient.hGetAll('openChallenges');
    const challenges = Object.values(rawChallenges).map(c => JSON.parse(c)).filter(c => !c.isPrivate);
    io.emit('lobby_update', challenges);
}

io.on('connection', async (socket) => {
    // Send the current lobby from Redis to the new user
    await broadcastLobby();

    socket.on('create_challenge', async (data) => {
        const { userId, username, stake, mode, isPrivate, elo } = data;
        const balCol = mode === 'real' ? 'real_balance' : 'demo_balance';
        
        try {
            const userRes = await pool.query(`SELECT ${balCol} as bal FROM users WHERE id = $1`, [userId]);
            if (userRes.rowCount === 0 || userRes.rows[0].bal < stake) return socket.emit('error', { message: 'Salio Halitoshi!' });

            const roomId = isPrivate ? Math.random().toString(36).substr(2, 5).toUpperCase() : 'pub_' + Date.now();
            await pool.query(`UPDATE users SET ${balCol} = ${balCol} - $1 WHERE id = $2`, [stake, userId]);
            
            socket.join(roomId);
            socket.roomId = roomId;
            socket.userId = userId;
            
            const challenge = { roomId, hostId: socket.id, userId, hostName: username, stake: parseInt(stake), mode, isPrivate, elo };
            
            // PHASE 3: Save to Redis instead of local array
            await pubClient.hSet('openChallenges', roomId, JSON.stringify(challenge));
            
            socket.emit('game_created', { roomId, isPrivate });
            await broadcastLobby(); // Update everyone's screen
            
            if (mode === 'real') await pool.query(`INSERT INTO transactions (user_id, type, amount, status) VALUES ($1, 'ENTRY_FEE', $2, 'PENDING')`, [userId, stake]);
        } catch (err) { console.error("Create challenge error:", err); }
    });

    socket.on('join_challenge', async (data) => {
        const { userId, username, roomId, elo } = data;
        
        // PHASE 3: Fetch challenge from Redis
        const rawChallenge = await pubClient.hGet('openChallenges', roomId);
        if (!rawChallenge) return socket.emit('error', { message: 'Mechi haipatikani.' });
        
        const challenge = JSON.parse(rawChallenge);
        if (challenge.userId == userId) return socket.emit('error', { message: 'Huwezi kucheza dhidi yako!' });

        const balCol = challenge.mode === 'real' ? 'real_balance' : 'demo_balance';

        try {
            const userRes = await pool.query(`SELECT ${balCol} as bal FROM users WHERE id = $1`, [userId]);
            if (userRes.rowCount === 0 || userRes.rows[0].bal < challenge.stake) return socket.emit('error', { message: 'Salio Halitoshi!' });

            // PHASE 3: Remove from open challenges, move to active rooms in Redis
            await pubClient.hDel('openChallenges', roomId);
            await broadcastLobby();

            await pool.query(`UPDATE users SET ${balCol} = ${balCol} - $1 WHERE id = $2`, [challenge.stake, userId]);
            
            socket.join(roomId);
            socket.roomId = roomId;
            socket.userId = userId;

            const activeRoomData = {
                p1: { id: challenge.hostId, userId: challenge.userId, elo: challenge.elo },
                p2: { id: socket.id, userId: userId, elo: elo },
                stake: challenge.stake,
                mode: challenge.mode,
                processed: false
            };
            await pubClient.hSet('activeRooms', roomId, JSON.stringify(activeRoomData));
            
            if (challenge.mode === 'real') await pool.query(`INSERT INTO transactions (user_id, type, amount, status) VALUES ($1, 'ENTRY_FEE', $2, 'PENDING')`, [userId, challenge.stake]);

            io.to(roomId).emit('game_start', {
                roomId,
                players: { red: challenge.hostId, white: socket.id },
                usernames: { red: challenge.hostName, white: username },
                stake: challenge.stake
            });
        } catch(err) { console.error("Join challenge error:", err); }
    });

    socket.on('cancel_challenge', async () => {
        // Find this user's challenge in Redis
        const rawChallenges = await pubClient.hGetAll('openChallenges');
        for (const [roomId, challengeStr] of Object.entries(rawChallenges)) {
            const c = JSON.parse(challengeStr);
            if (c.hostId === socket.id) {
                const balCol = c.mode === 'real' ? 'real_balance' : 'demo_balance';
                await pubClient.hDel('openChallenges', roomId);
                await broadcastLobby();
                try {
                    await pool.query(`UPDATE users SET ${balCol} = ${balCol} + $1 WHERE id = $2`, [c.stake, c.userId]);
                } catch(e) {}
                socket.emit('challenge_cancelled');
                break;
            }
        }
    });

    socket.on('make_move', (data) => { if (socket.roomId) socket.to(socket.roomId).emit('opponent_move', data); });

    const handleGameOver = async (roomId, winnerSocketId, reason) => {
        const rawRoom = await pubClient.hGet('activeRooms', roomId);
        if (!rawRoom) return;
        
        const room = JSON.parse(rawRoom);
        if (room.processed) return;
        
        room.processed = true;
        await pubClient.hSet('activeRooms', roomId, JSON.stringify(room)); // Mark as processed to prevent double payouts

        const isDraw = reason === 'draw';
        const balCol = room.mode === 'real' ? 'real_balance' : 'demo_balance';
        const totalPot = room.stake * 2;

        try {
            if (isDraw) {
                const platformFee = Math.floor(totalPot * 0.10);
                const refund = Math.floor((totalPot - platformFee) / 2);
                await pool.query(`UPDATE users SET ${balCol} = ${balCol} + $1 WHERE id IN ($2, $3)`, [refund, room.p1.userId, room.p2.userId]);
                if (room.mode === 'real') await pool.query(`UPDATE admin_wallet SET balance = balance + $1 WHERE id = 1`, [platformFee]);
                io.to(roomId).emit('match_result', { isDraw: true, refund });
            } else {
                const winner = winnerSocketId === room.p1.id ? room.p1 : room.p2;
                const loser = winnerSocketId === room.p1.id ? room.p2 : room.p1;
                
                const platformFee = Math.floor(totalPot * 0.10); 
                const winnerTake = totalPot - platformFee;
                const newElos = updateElo(winner.elo, loser.elo);

                await pool.query(`UPDATE users SET ${balCol} = ${balCol} + $1, elo = $2 WHERE id = $3`, [winnerTake, newElos.newWinnerElo, winner.userId]);
                await pool.query(`UPDATE users SET elo = $1 WHERE id = $2`, [newElos.newLoserElo, loser.userId]);

                if (room.mode === 'real') {
                    await pool.query(`UPDATE admin_wallet SET balance = balance + $1 WHERE id = 1`, [platformFee]);
                    await pool.query(`INSERT INTO transactions (user_id, type, amount, status) VALUES ($1, 'PRIZE_PAYOUT', $2, 'SUCCESS')`, [winner.userId, winnerTake]);
                }

                io.to(roomId).emit('match_result', { isDraw: false, winnerId: winner.userId, payout: winnerTake, reason });
            }
        } catch(err) { console.error("Game over error:", err); }
        
        // Clean up room from Redis
        await pubClient.hDel('activeRooms', roomId);
    };

    socket.on('game_over', (data) => handleGameOver(socket.roomId, data.winner === 'me' ? socket.id : null, 'regular'));
    socket.on('timeout_loss', async () => {
        if (!socket.roomId) return;
        const rawRoom = await pubClient.hGet('activeRooms', socket.roomId);
        if (rawRoom) {
            const room = JSON.parse(rawRoom);
            const opponentId = room.p1.id === socket.id ? room.p2.id : room.p1.id;
            handleGameOver(socket.roomId, opponentId, 'timeout');
        }
    });
    
    socket.on('offer_draw', () => socket.to(socket.roomId).emit('draw_offered'));
    socket.on('accept_draw', () => handleGameOver(socket.roomId, null, 'draw'));

    socket.on('disconnect', async () => {
        // Clean up challenges
        const rawChallenges = await pubClient.hGetAll('openChallenges');
        for (const [roomId, challengeStr] of Object.entries(rawChallenges)) {
            const c = JSON.parse(challengeStr);
            if (c.hostId === socket.id) {
                const balCol = c.mode === 'real' ? 'real_balance' : 'demo_balance';
                try { await pool.query(`UPDATE users SET ${balCol} = ${balCol} + $1 WHERE id = $2`, [c.stake, c.userId]); } catch(e) {}
                await pubClient.hDel('openChallenges', roomId);
                await broadcastLobby();
                break;
            }
        }
        
        // Handle disconnect during active game
        if (socket.roomId) {
            const rawRoom = await pubClient.hGet('activeRooms', socket.roomId);
            if (rawRoom) {
                const room = JSON.parse(rawRoom);
                if (!room.processed) {
                    const opponentId = room.p1.id === socket.id ? room.p2.id : room.p1.id;
                    handleGameOver(socket.roomId, opponentId, 'abandon');
                }
            }
        }
    });
});

const PORT = process.env.PORT || 7860;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
