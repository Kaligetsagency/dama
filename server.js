const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const path = require('path');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('redis');
const { createAdapter } = require('@socket.io/redis-adapter');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(cors());

// ==========================================
// 1. REDIS SETUP 
// ==========================================
let pubClient, subClient;

if (process.env.REDIS_URL) {
    pubClient = createClient({ url: process.env.REDIS_URL });
    subClient = pubClient.duplicate();

    Promise.all([pubClient.connect(), subClient.connect()]).then(() => {
        io.adapter(createAdapter(pubClient, subClient));
        console.log('✅ Connected to Redis');
    }).catch(err => console.error('❌ Redis Connection Error:', err));
} else {
    console.log('⚠️ No REDIS_URL found. Running without Redis for local dev fallback.');
}

// ==========================================
// 2. DATABASE SETUP 
// ==========================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/vutapumzi',
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                phone VARCHAR(20) UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                role VARCHAR(10) DEFAULT 'user',
                real_balance INT DEFAULT 0,
                demo_balance INT DEFAULT 10000,
                token TEXT
            );
            CREATE TABLE IF NOT EXISTS platform_stats (
                id INT PRIMARY KEY DEFAULT 1,
                collected_fees INT DEFAULT 0,
                games_played INT DEFAULT 0
            );
            INSERT INTO platform_stats (id, collected_fees, games_played) VALUES (1, 0, 0) ON CONFLICT DO NOTHING;
        `);
        console.log('✅ Database tables initialized.');
    } catch (err) {
        console.error('❌ DB Init Error:', err);
    }
}
initDB();

// ==========================================
// 3. API ROUTES (Auth & Admin)
// ==========================================

// Authentication Middleware
async function authenticate(req, res, next) {
    const token = req.headers['authorization'];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const { rows } = await pool.query('SELECT id, phone, role, real_balance, demo_balance FROM users WHERE token = $1', [token]);
        if (rows.length === 0) return res.status(401).json({ error: 'Invalid token' });
        req.user = rows[0];
        next();
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
}

app.post('/api/register', async (req, res) => {
    const { phone, password } = req.body;
    try {
        const hash = await bcrypt.hash(password, 10);
        const role = phone === 'admin' ? 'admin' : 'user'; // Special admin creation
        await pool.query('INSERT INTO users (phone, password_hash, role) VALUES ($1, $2, $3)', [phone, hash, role]);
        res.json({ success: true, message: 'Registered successfully!' });
    } catch (err) {
        res.status(400).json({ error: 'Phone number already exists or invalid data.' });
    }
});

app.post('/api/login', async (req, res) => {
    const { phone, password } = req.body;
    try {
        const { rows } = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
        if (rows.length === 0) return res.status(400).json({ error: 'User not found' });
        
        const match = await bcrypt.compare(password, rows[0].password_hash);
        if (!match) return res.status(400).json({ error: 'Incorrect password' });

        const token = uuidv4();
        await pool.query('UPDATE users SET token = $1 WHERE id = $2', [token, rows[0].id]);
        
        const user = { id: rows[0].id, phone: rows[0].phone, role: rows[0].role, real: rows[0].real_balance, demo: rows[0].demo_balance };
        res.json({ success: true, token, user });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/me', authenticate, (req, res) => {
    res.json({ user: { id: req.user.id, phone: req.user.phone, role: req.user.role, real: req.user.real_balance, demo: req.user.demo_balance } });
});

// Password Management
app.post('/api/forgot-password', async (req, res) => {
    const { phone, newPassword } = req.body;
    try {
        const { rows } = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
        if (rows.length === 0) return res.status(400).json({ error: 'User not found' });
        const hash = await bcrypt.hash(newPassword, 10);
        await pool.query('UPDATE users SET password_hash = $1 WHERE phone = $2', [hash, phone]);
        res.json({ success: true, message: 'Password reset successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/change-password', authenticate, async (req, res) => {
    const { oldPassword, newPassword } = req.body;
    try {
        const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
        const match = await bcrypt.compare(oldPassword, rows[0].password_hash);
        if (!match) return res.status(400).json({ error: 'Incorrect old password' });

        const hash = await bcrypt.hash(newPassword, 10);
        await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
        res.json({ success: true, message: 'Password updated successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Admin Panel Routes
app.get('/api/admin/stats', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    try {
        const { rows } = await pool.query('SELECT collected_fees, games_played FROM platform_stats WHERE id = 1');
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/admin/withdraw', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    try {
        await pool.query('UPDATE platform_stats SET collected_fees = 0 WHERE id = 1');
        res.json({ success: true, message: 'Funds withdrawn successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ==========================================
// 4. SOCKET.IO (Game Logic & Lobby)
// ==========================================
const lobbies = {}; // Simple in-memory fallback for lobbies if Redis pub/sub isn't fully utilized here

io.on('connection', (socket) => {
    socket.on('join_lobby', () => {
        socket.join('lobby');
    });

    socket.on('create_challenge', async (data) => {
        // Handle fee deduction logic here (10% fee assumed in real implementation)
        io.to('lobby').emit('challenge_created', data);
    });

    socket.on('disconnect', () => {
        // Cleanup challenges/rooms
    });
    
    // Additional Game Sync Logic goes here
});

// Fallback route for SPA
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
