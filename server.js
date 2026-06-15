const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e6 });

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: 'admin-secret-key-2025',
    resave: false,
    saveUninitialized: false
}));

// ---------- DATABASE ----------
let db;
async function setupDatabase() {
    db = await open({
        filename: './chat.db',
        driver: sqlite3.Database
    });
    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            user_id TEXT PRIMARY KEY,
            name TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            content TEXT,
            is_image BOOLEAN DEFAULT 0,
            from_role TEXT,
            to_role TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(user_id)
        );
    `);
    console.log('✅ Database ready');
}
setupDatabase();

const onlineUsers = new Map();

// ---------- HELPER FUNCTIONS ----------
async function saveMessage(userId, content, fromRole, toRole, isImage = false) {
    await db.run(
        'INSERT INTO messages (user_id, content, is_image, from_role, to_role) VALUES (?, ?, ?, ?, ?)',
        [userId, content, isImage ? 1 : 0, fromRole, toRole]
    );
}

async function getUserMessages(userId) {
    const msgs = await db.all(
        'SELECT content, is_image, from_role, timestamp FROM messages WHERE user_id = ? ORDER BY timestamp ASC',
        [userId]
    );
    return msgs.map(m => ({
        content: m.content,
        timestamp: m.timestamp,
        from: m.from_role === 'ADMIN' ? 'ADMIN' : userId,
        isImage: m.is_image === 1
    }));
}

async function getAllUsersWithMessageCount() {
    const users = await db.all(`
        SELECT u.user_id, u.name, COUNT(m.id) as msg_count
        FROM users u
        LEFT JOIN messages m ON u.user_id = m.user_id AND m.from_role != 'ADMIN'
        GROUP BY u.user_id
        ORDER BY MAX(m.timestamp) DESC
    `);
    return users.map(u => ({
        userId: u.user_id,
        name: u.name,
        messageCount: u.msg_count || 0
    }));
}

async function registerUser(userId, name) {
    await db.run('INSERT OR IGNORE INTO users (user_id, name) VALUES (?, ?)', [userId, name]);
}

async function deleteUserConversation(userId) {
    await db.run('DELETE FROM messages WHERE user_id = ?', [userId]);
}

// ---------- SOCKET.IO ----------
io.on('connection', async (socket) => {
    const userId = socket.handshake.query.userId;
    const isAdmin = socket.handshake.query.admin === 'true';

    if (isAdmin) {
        socket.join('admin-room');
        console.log('🛡️ Admin connected');

        const userList = await getAllUsersWithMessageCount();
        socket.emit('admin-users-list', userList);

        socket.on('get-user-messages', async (targetUserId) => {
            const msgs = await getUserMessages(targetUserId);
            socket.emit('user-messages-history', { userId: targetUserId, messages: msgs });
        });

        socket.on('admin-reply', async ({ toUserId, message }) => {
            await saveMessage(toUserId, message, 'ADMIN', toUserId, false);
            const replyMsg = {
                content: message,
                timestamp: new Date().toISOString(),
                from: 'ADMIN',
                isImage: false
            };
            if (onlineUsers.has(toUserId)) {
                io.to(toUserId).emit('admin-message', replyMsg);
            }
            socket.emit('reply-confirm', { success: true });
        });

        socket.on('transaction-done', async ({ userId }) => {
            await deleteUserConversation(userId);
            // Notify the user if online to clear their chat
            if (onlineUsers.has(userId)) {
                io.to(userId).emit('conversation-cleared');
            }
            // Also refresh the user list for admin
            const updatedList = await getAllUsersWithMessageCount();
            io.to('admin-room').emit('admin-users-list', updatedList);
            socket.emit('transaction-confirmed', { userId });
        });
    }
    else {
        if (!userId) return socket.disconnect();
        socket.join(userId);
        onlineUsers.set(userId, socket.id);
        const userName = `User_${userId.slice(-5)}`;
        await registerUser(userId, userName);
        console.log(`👤 User connected: ${userId}`);

        const history = await getUserMessages(userId);
        socket.emit('conversation-history', history);

        socket.on('send-message', async (data) => {
            const isImage = data.type === 'image';
            await saveMessage(userId, data.content, userId, 'ADMIN', isImage);
            const userMsg = {
                content: data.content,
                timestamp: new Date().toISOString(),
                from: userId,
                isImage: isImage
            };
            const userData = await db.get('SELECT name FROM users WHERE user_id = ?', [userId]);
            io.to('admin-room').emit('new-user-message', {
                userId: userId,
                userName: userData?.name || userName,
                message: userMsg
            });
            socket.emit('message-sent', userMsg);
        });

        socket.on('disconnect', () => {
            onlineUsers.delete(userId);
        });
    }
});

// ---------- ADMIN LOGIN ROUTES ----------
const ADMIN_USER = 'AdminK';
const ADMIN_PASS = '272504d3kings';

app.get('/admin/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USER && password === ADMIN_PASS) {
        req.session.admin = true;
        res.redirect('/admin');
    } else {
        res.send('<h3>Invalid credentials. <a href="/admin/login">Try again</a></h3>');
    }
});

app.get('/admin/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/admin/login');
});

function requireAdmin(req, res, next) {
    if (req.session.admin) return next();
    res.redirect('/admin/login');
}

app.get('/admin', requireAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Public routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'user.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`👑 Admin login: /admin/login`);
    console.log(`💬 User chat: /`);
});
