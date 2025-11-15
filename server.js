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

// Initialize Database Tables
async function initializeDatabase() {
    try {
        console.log('Initializing database...');
        
        // Create users table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                email VARCHAR(100) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                role ENUM('admin', 'manager', 'user') DEFAULT 'user',
                status ENUM('active', 'inactive') DEFAULT 'active',
                created_by INT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
            )
        `);
        console.log('✓ Users table ready');
        
        // Create activity_logs table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS activity_logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                action VARCHAR(255) NOT NULL,
                details TEXT,
                ip_address VARCHAR(45),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);
        console.log('✓ Activity logs table ready');
        
        // Check if admin exists
        const [admins] = await pool.query('SELECT * FROM users WHERE email = ?', ['admin@dashboard.com']);
        
        if (admins.length === 0) {
            // Create default admin user
            const hashedPassword = await bcrypt.hash('Admin@123', 10);
            await pool.query(
                'INSERT INTO users (name, email, password, role, status) VALUES (?, ?, ?, ?, ?)',
                ['System Admin', 'admin@dashboard.com', hashedPassword, 'admin', 'active']
            );
            console.log('✓ Default admin user created');
            console.log('  Email: admin@dashboard.com');
            console.log('  Password: Admin@123');
        } else {
            console.log('✓ Admin user already exists');
        }
        
        console.log('Database initialization complete!');
    } catch (error) {
        console.error('Database initialization error:', error);
        process.exit(1);
    }
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(session({
    secret: process.env.SESSION_SECRET || 'fallback-secret-key-change-this',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false,
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000,
        sameSite: 'lax'
    },
    name: 'sessionId'
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

app.get('/login-test', (req, res) => {
    res.render('login-test');
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    
    console.log('Login attempt:', email);
    
    try {
        const [users] = await pool.query('SELECT * FROM users WHERE email = ? AND status = ?', [email, 'active']);
        
        console.log('Users found:', users.length);
        
        if (users.length === 0) {
            console.log('No user found with email:', email);
            return res.json({ success: false, message: 'Invalid credentials' });
        }
        
        const user = users[0];
        console.log('Comparing passwords for user:', user.name);
        
        const validPassword = await bcrypt.compare(password, user.password);
        
        console.log('Password valid:', validPassword);
        
        if (!validPassword) {
            return res.json({ success: false, message: 'Invalid credentials' });
        }
        
        req.session.userId = user.id;
        req.session.userName = user.name;
        req.session.userRole = user.role;
        
        console.log('Session created for user:', user.name);
        
        await pool.query('INSERT INTO activity_logs (user_id, action, ip_address) VALUES (?, ?, ?)', 
            [user.id, 'Login', req.ip]);
        
        console.log('Login successful for:', email);
        res.json({ success: true, message: 'Login successful' });
    } catch (error) {
        console.error('Login error:', error);
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

// Initialize database and start server
initializeDatabase().then(() => {
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
}).catch(error => {
    console.error('Failed to initialize:', error);
    process.exit(1);
});
