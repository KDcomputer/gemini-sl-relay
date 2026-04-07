// ╔══════════════════════════════════════════════════════════════╗
// ║  ✨ GEMINI RELAY SERVER — Node.js for Render.com            ║
// ║  Persistent memory per avatar using PostgreSQL (Neon)       ║
// ╚══════════════════════════════════════════════════════════════╝

const express  = require('express');
const { Pool } = require('pg');
const fetch    = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app  = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Config (set these as Environment Variables in Render) ──────
const SHARED_SECRET = process.env.SHARED_SECRET || 'CHANGE_ME';
const GEMINI_KEY    = process.env.GEMINI_KEY     || 'CHANGE_ME';
const DATABASE_URL  = process.env.DATABASE_URL;   // Set in Render from Neon

// ── Gemini API Config ──────────────────────────────────────────
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;
const MAX_HISTORY = 8; // messages to keep per avatar (4 exchanges)

// ── PostgreSQL Pool ────────────────────────────────────────────
const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ── Init DB tables ─────────────────────────────────────────────
async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS avatar_memory (
            avatar_key   TEXT PRIMARY KEY,
            avatar_name  TEXT,
            history      TEXT DEFAULT '[]',
            facts        TEXT DEFAULT '',
            total_chats  INTEGER DEFAULT 0,
            last_seen    TIMESTAMP DEFAULT NOW(),
            created_at   TIMESTAMP DEFAULT NOW()
        );
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS global_facts (
            id    SERIAL PRIMARY KEY,
            fact  TEXT NOT NULL,
            added TIMESTAMP DEFAULT NOW()
        );
    `);
    console.log('✅ Database ready');
}

// ── Auth middleware ────────────────────────────────────────────
function checkSecret(req, res, next) {
    const secret = req.body?.secret || req.query?.secret;
    if (secret !== SHARED_SECRET) {
        return res.json({ error: 'Invalid secret key' });
    }
    next();
}

// ── Personality prompts ────────────────────────────────────────
const PERSONALITIES = {
    friendly:   'You are {NAME}, a warm, helpful, and cheerful AI assistant in Second Life. Be conversational and friendly.',
    mystic:     'You are {NAME}, a mysterious and wise oracle in Second Life. Speak in mystical, slightly cryptic terms. Use metaphor and wisdom.',
    sarcastic:  'You are {NAME}, a witty and sarcastic AI in Second Life. Be helpful but with a dry, clever sense of humour.',
    guide:      'You are {NAME}, an expert Second Life guide and assistant. Give clear, practical help about Second Life and general topics.',
    roleplay:   'You are {NAME}, an immersive roleplay character in Second Life. Stay in character and engage with the story.',
    pirate:     'You are {NAME}, a swashbuckling pirate in Second Life. Speak like a pirate — arrr, matey! Be fun and adventurous.',
    scientist:  'You are {NAME}, a brilliant scientist AI in Second Life. Be precise, analytical, and occasionally get excited about science.',
    bard:       'You are {NAME}, a poetic bard in Second Life. Speak in verse when possible, be dramatic and eloquent.',
};

// ── Routes ─────────────────────────────────────────────────────

// Health check (no auth needed)
app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'Gemini SL Relay', version: '3.0' });
});

// Stats
app.get('/stats', checkSecret, async (req, res) => {
    try {
        const avatars = await pool.query('SELECT COUNT(*) as count FROM avatar_memory');
        const chats   = await pool.query('SELECT SUM(total_chats) as total FROM avatar_memory');
        const facts   = await pool.query('SELECT COUNT(*) as count FROM global_facts');
        res.json({
            status:       'ok',
            avatars:      parseInt(avatars.rows[0].count),
            total_chats:  parseInt(chats.rows[0].total) || 0,
            global_facts: parseInt(facts.rows[0].count),
        });
    } catch (e) {
        res.json({ error: e.message });
    }
});

// Remember a global fact
app.post('/remember', checkSecret, async (req, res) => {
    const { fact } = req.body;
    if (!fact) return res.json({ error: 'No fact provided' });
    await pool.query('INSERT INTO global_facts (fact) VALUES ($1)', [fact]);
    res.json({ status: 'ok', message: 'Fact remembered!' });
});

// Forget all global facts
app.post('/forget', checkSecret, async (req, res) => {
    await pool.query('DELETE FROM global_facts');
    res.json({ status: 'ok', message: 'All global facts cleared.' });
});

// Reset an avatar's memory
app.post('/reset', checkSecret, async (req, res) => {
    const { avatar_key } = req.body;
    if (!avatar_key) return res.json({ error: 'No avatar_key' });
    await pool.query(
        'UPDATE avatar_memory SET history = $1, facts = $2 WHERE avatar_key = $3',
        ['[]', '', avatar_key]
    );
    res.json({ status: 'ok', message: 'Memory cleared.' });
});

// Reset ALL avatar memories
app.post('/resetall', checkSecret, async (req, res) => {
    await pool.query('UPDATE avatar_memory SET history = $1, facts = $2', ['[]', '']);
    res.json({ status: 'ok', message: 'All memories cleared.' });
});

// ── Main Chat Endpoint ─────────────────────────────────────────
app.post('/chat', checkSecret, async (req, res) => {
    const {
        avatar_key,
        avatar_name = 'Unknown',
        message,
        ai_name = 'Gemini',
        ai_mode = 'friendly',
        remember_fact,
    } = req.body;

    if (!avatar_key || !message) {
        return res.json({ error: 'Missing avatar_key or message' });
    }

    try {
        // Handle !remember command
        if (remember_fact) {
            await pool.query(
                'INSERT INTO avatar_memory (avatar_key, avatar_name, facts) VALUES ($1,$2,$3) ON CONFLICT (avatar_key) DO UPDATE SET facts = avatar_memory.facts || $4, last_seen = NOW()',
                [avatar_key, avatar_name, remember_fact + '\n', '\n' + remember_fact]
            );
            return res.json({ reply: `Got it! I'll remember: ${remember_fact}` });
        }

        // Get or create avatar record
        await pool.query(
            'INSERT INTO avatar_memory (avatar_key, avatar_name) VALUES ($1,$2) ON CONFLICT (avatar_key) DO UPDATE SET avatar_name=$2, last_seen=NOW()',
            [avatar_key, avatar_name]
        );

        const row = await pool.query(
            'SELECT history, facts FROM avatar_memory WHERE avatar_key=$1',
            [avatar_key]
        );

        let history = JSON.parse(row.rows[0].history || '[]');
        const avatarFacts = row.rows[0].facts || '';

        // Get global facts
        const gfResult = await pool.query('SELECT fact FROM global_facts ORDER BY added');
        const globalFacts = gfResult.rows.map(r => r.fact).join('\n');

        // Build system prompt
        const modeTemplate = PERSONALITIES[ai_mode] || PERSONALITIES.friendly;
        let systemPrompt = modeTemplate.replace(/{NAME}/g, ai_name);
        systemPrompt += `\n\nYou are speaking with ${avatar_name} in Second Life.`;
        systemPrompt += '\nKeep responses concise (under 200 chars ideally — SL chat is short).';
        systemPrompt += '\nNever use markdown formatting like ** or ## — plain text only.';

        if (globalFacts) systemPrompt += `\n\nWorld/location facts:\n${globalFacts}`;
        if (avatarFacts) systemPrompt += `\n\nFacts about ${avatar_name}:\n${avatarFacts}`;

        // Build contents array for Gemini
        const contents = [];

        // Add conversation history
        for (const turn of history) {
            contents.push({ role: turn.role, parts: [{ text: turn.text }] });
        }

        // Add current message
        contents.push({ role: 'user', parts: [{ text: message }] });

        // Call Gemini
        const geminiBody = {
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents: contents,
            generationConfig: {
                maxOutputTokens: 200,
                temperature: 0.85,
            },
            safetySettings: [
                { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
                { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
                { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
                { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
            ],
        };

        const gemRes  = await fetch(GEMINI_URL, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(geminiBody),
        });

        const gemData = await gemRes.json();

        if (!gemRes.ok || !gemData.candidates?.[0]) {
            const errMsg = gemData.error?.message || 'Gemini API error';
            console.error('Gemini error:', errMsg);
            return res.json({ error: errMsg });
        }

        const reply = gemData.candidates[0].content.parts[0].text.trim();

        // Update history
        history.push({ role: 'user',  text: message });
        history.push({ role: 'model', text: reply });

        // Trim history if too long
        while (history.length > MAX_HISTORY) history.shift();

        // Save back to DB
        await pool.query(
            'UPDATE avatar_memory SET history=$1, total_chats=total_chats+1, last_seen=NOW() WHERE avatar_key=$2',
            [JSON.stringify(history), avatar_key]
        );

        res.json({ reply: reply });

    } catch (e) {
        console.error('Chat error:', e);
        res.json({ error: e.message });
    }
});

// ── Start ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    await initDB();
    console.log(`🚀 Gemini SL Relay running on port ${PORT}`);
});
