require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Database connection pool
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Auth Middleware
const requireAuth = (req, res, next) => {
    if (req.session.userId) {
        next();
    } else {
        res.redirect('/login');
    }
};

const requireAdmin = async (req, res, next) => {
    if (!req.session.userId) {
        return res.redirect('/login');
    }
    try {
        const [users] = await pool.query('SELECT role FROM users WHERE id = ?', [req.session.userId]);
        if (users.length && (users[0].role === 'admin' || users[0].role === 'manager')) {
            next();
        } else {
            res.status(403).json({ success: false, message: 'Access denied' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// Routes
app.get('/', (req, res) => {
    if (req.session.userId) {
        res.redirect('/dashboard');
    } else {
        res.redirect('/login');
    }
});

app.get('/login', (req, res) => {
    if (req.session.userId) {
        return res.redirect('/dashboard');
    }
    res.render('login');
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    
    try {
        const [users] = await pool.query('SELECT * FROM users WHERE email = ? AND status = ?', [email, 'active']);
        
        if (users.length === 0) {
            return res.json({ success: false, message: 'Invalid credentials' });
        }
        
        const user = users[0];
        const validPassword = await bcrypt.compare(password, user.password);
        
        if (!validPassword) {
            return res.json({ success: false, message: 'Invalid credentials' });
        }
        
        req.session.userId = user.id;
        req.session.userName = user.name;
        req.session.userRole = user.role;
        
        await pool.query('INSERT INTO activity_logs (user_id, action, ip_address) VALUES (?, ?, ?)', 
            [user.id, 'Login', req.ip]);
        
        res.json({ success: true, message: 'Login successful' });
    } catch (error) {
        console.error(error);
        res.json({ success: false, message: 'Server error' });
    }
});

app.get('/dashboard', requireAuth, async (req, res) => {
    try {
        const [users] = await pool.query('SELECT COUNT(*) as count FROM users');
        const [logs] = await pool.query('SELECT COUNT(*) as count FROM activity_logs WHERE DATE(created_at) = CURDATE()');
        const [recentUsers] = await pool.query('SELECT name, email, role, created_at FROM users ORDER BY created_at DESC LIMIT 5');
        
        res.render('dashboard', {
            user: {
                name: req.session.userName,
                role: req.session.userRole
            },
            stats: {
                totalUsers: users[0].count,
                todayActivity: logs[0].count
            },
            recentUsers
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Server error');
    }
});

app.get('/users', requireAdmin, async (req, res) => {
    try {
        const [users] = await pool.query('SELECT id, name, email, role, status, created_at FROM users ORDER BY created_at DESC');
        res.render('users', {
            user: {
                name: req.session.userName,
                role: req.session.userRole
            },
            users
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Server error');
    }
});

app.post('/users/create', requireAdmin, async (req, res) => {
    const { name, email, password, role } = req.body;
    
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        await pool.query('INSERT INTO users (name, email, password, role, created_by) VALUES (?, ?, ?, ?, ?)',
            [name, email, hashedPassword, role, req.session.userId]);
        
        await pool.query('INSERT INTO activity_logs (user_id, action, details) VALUES (?, ?, ?)',
            [req.session.userId, 'Create User', `Created user: ${email}`]);
        
        res.json({ success: true, message: 'User created successfully' });
    } catch (error) {
        console.error(error);
        res.json({ success: false, message: 'Failed to create user' });
    }
});

app.post('/users/update', requireAdmin, async (req, res) => {
    const { id, name, email, role, status } = req.body;
    
    try {
        await pool.query('UPDATE users SET name = ?, email = ?, role = ?, status = ? WHERE id = ?',
            [name, email, role, status, id]);
        
        await pool.query('INSERT INTO activity_logs (user_id, action, details) VALUES (?, ?, ?)',
            [req.session.userId, 'Update User', `Updated user ID: ${id}`]);
        
        res.json({ success: true, message: 'User updated successfully' });
    } catch (error) {
        console.error(error);
        res.json({ success: false, message: 'Failed to update user' });
    }
});

app.post('/users/delete', requireAdmin, async (req, res) => {
    const { id } = req.body;
    
    if (id == req.session.userId) {
        return res.json({ success: false, message: 'Cannot delete your own account' });
    }
    
    try {
        await pool.query('DELETE FROM users WHERE id = ?', [id]);
        res.json({ success: true, message: 'User deleted successfully' });
    } catch (error) {
        console.error(error);
        res.json({ success: false, message: 'Failed to delete user' });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});