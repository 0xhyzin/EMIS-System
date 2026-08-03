import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import { initDatabase } from './db/database.js';
import apiRouter from './routes/api.js';
import exportRouter from './routes/export.js';
import multer from 'multer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(join(__dirname, 'public')));

// Ensure directories exist
const publicAssetsDir = join(__dirname, 'public', 'assets');
if (!fs.existsSync(publicAssetsDir)) {
    fs.mkdirSync(publicAssetsDir, { recursive: true });
}

// Logo upload setup
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, publicAssetsDir);
    },
    filename: (req, file, cb) => {
        cb(null, 'logo.png');
    }
});
const upload = multer({ storage });

app.post('/api/upload-logo', upload.single('logo'), (req, res) => {
    res.json({ success: true, path: '/assets/logo.png' });
});

app.use('/api', apiRouter);
app.use('/api', exportRouter);

// Initialize DB and create tables
initDatabase();

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
