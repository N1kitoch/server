import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import YAML from 'yaml';

// Resolve __dirname in ES module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load YAML config (prefer bot/config.yaml)
let YAML_CONFIG = {};
try {
	const candidates = [
		path.resolve(__dirname, '../bot/config.yaml'),
		path.resolve(__dirname, '../config.yaml'),
	];
	for (const configPath of candidates) {
		if (fs.existsSync(configPath)) {
			const raw = fs.readFileSync(configPath, 'utf8');
			YAML_CONFIG = YAML.parse(raw) || {};
			break;
		}
	}
} catch {}

// Env with YAML fallback
const BOT_TOKEN = process.env.BOT_TOKEN || (YAML_CONFIG.bot?.token || '');
const ADMIN_ID = process.env.ADMIN_ID || String(YAML_CONFIG.bot?.admin_id || '585028258');
const PORT = Number(process.env.PORT || YAML_CONFIG.backend?.port || 3000);
const HOST = process.env.HOST || YAML_CONFIG.backend?.host || '0.0.0.0';
const PUBLIC_STATIC_URL = process.env.PUBLIC_STATIC_URL || (YAML_CONFIG.backend?.public_static_url || '');
let BOT_USERNAME = process.env.BOT_TOKEN || (YAML_CONFIG.bot?.username || '');
const TUNNEL_DOMAIN = process.env.TUNNEL_DOMAIN || (YAML_CONFIG.backend?.tunnel_domain || '');
const TUNNEL_URL = process.env.TUNNEL_URL || (YAML_CONFIG.backend?.tunnel_url || '');

if (!BOT_TOKEN) {
	console.error('Missing BOT_TOKEN in environment or config file');
	process.exit(1);
}

// App setup
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '1mb' }));

// Health endpoint - always return success for local development
app.get('/health', (req, res) => {
	res.json({ ok: true, time: Date.now(), mode: 'local' });
});

// WebSocket hub (backend -> mini app)
const userIdToSockets = new Map();
const userIdToQueue = new Map();
function enqueueForUser(userId, data) {
	const key = String(userId);
	if (!userIdToQueue.has(key)) userIdToQueue.set(key, []);
	userIdToQueue.get(key).push(data);
}
function pushToUser(userId, data) {
	try {
		enqueueForUser(userId, data);
		const set = userIdToSockets.get(String(userId));
		if (!set) return;
		const payload = JSON.stringify(data);
		for (const ws of Array.from(set)) {
			try { ws.send(payload); } catch {}
		}
	} catch {}
}

app.get('/poll', (req, res) => {
	try {
		const userId = String(req.query.user_id || '');
		if (!userId) return res.status(400).json({ ok: false, error: 'no user_id' });
		const items = userIdToQueue.get(userId) || [];
		userIdToQueue.set(userId, []);
		return res.json({ ok: true, items });
	} catch (e) {
		return res.status(500).json({ ok: false });
	}
});

// Answer WebApp Query via Bot API
async function answerWebAppQueryHTTP(queryId, payload) {
	const url = `https://api.telegram.org/bot${BOT_TOKEN}/answerWebAppQuery`;
	const body = {
		web_app_query_id: queryId,
		result: {
			type: 'article',
			id: String(Date.now()),
			title: 'Данные из Mini App',
			input_message_content: {
				message_text: `✅ Получены данные из Mini App:\n${JSON.stringify(payload, null, 2).slice(0, 3800)}`
			}
		}
	};
	const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
	const json = await resp.json().catch(() => ({}));
	if (!resp.ok || json.ok === false) {
		throw new Error('answerWebAppQuery failed: ' + (json.description || resp.statusText));
	}
	return json;
}

// Endpoint to receive WebApp data from inline mode via backend: expects { initData, payload, queryId }
app.post('/webapp-data', async (req, res) => {
	try {
		const { payload, queryId } = req.body || {};
		if (!payload) return res.status(400).json({ ok: false, error: 'No payload' });
		if (queryId) {
			await answerWebAppQueryHTTP(queryId, payload);
			const uid = payload?.userData?.id;
			if (uid) pushToUser(uid, { type: 'notification', level: 'success', message: 'Результат отправлен в чат' });
			return res.json({ ok: true });
		}
		// Fallback: notify admin
		await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
			method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ chat_id: ADMIN_ID, text: `Получены данные от WebApp без queryId:\n${JSON.stringify(payload).slice(0, 3800)}` })
		});
		return res.json({ ok: true });
	} catch (e) {
		console.error('webapp-data error', e);
		return res.status(500).json({ ok: false });
	}
});

let server;
// Use TUNNEL_URL if provided, otherwise fall back to localhost
let apiBaseUrl = TUNNEL_URL || `http://localhost:${PORT}`;
const publicStaticUrl = PUBLIC_STATIC_URL || `http://localhost:${PORT}`;

function getMiniAppUrl() {
	const base = `${publicStaticUrl}/index.html`;
	const url = new URL(base);
	url.searchParams.set('api', apiBaseUrl);
	if (BOT_USERNAME) url.searchParams.set('bot', BOT_USERNAME);
	return url.toString();
}

// Expose computed Mini App URL
app.get('/miniapp-url', (req, res) => {
	res.json({ url: getMiniAppUrl(), api: apiBaseUrl, static: publicStaticUrl });
});

// Serve static mini app (dev fallback; production should use GitHub Pages)
const staticDir = path.resolve(__dirname, '../web-app');
app.use('/', express.static(staticDir, { index: 'index.html' }));

async function resolveBotUsername() {
	try {
		if (BOT_USERNAME) return;
		const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
		const j = await r.json().catch(() => null);
		if (j && j.ok && j.result && j.result.username) {
			BOT_USERNAME = j.result.username;
			console.log('Resolved bot username:', BOT_USERNAME);
		}
	} catch {}
}

async function startTunnel() {
	// Skip Tunnelmole for now - use environment variable or localhost
	if (TUNNEL_URL) {
		console.log('Using provided TUNNEL_URL:', TUNNEL_URL);
		apiBaseUrl = TUNNEL_URL;
	} else {
		console.log('No TUNNEL_URL provided, using localhost');
		console.log('To use Tunnelmole, set TUNNEL_URL environment variable or run:');
		console.log('tmole 3100');
		console.log('Then set TUNNEL_URL=https://<generated-url>.tunnelmole.net');
	}
}

async function bootstrap() {
	server = app.listen(PORT, HOST, async () => {
		console.log(`HTTP server listening on http://${HOST}:${PORT}`);
		console.log(`Local Mini App URL: http://localhost:${PORT}`);
		if (PUBLIC_STATIC_URL) {
			console.log(`Static host for Mini App: ${PUBLIC_STATIC_URL}`);
		}
		if (TUNNEL_URL) {
			console.log(`Tunnel URL: ${TUNNEL_URL}`);
		}
		// Attach WS server
		const wss = new WebSocketServer({ server });
		wss.on('connection', (ws, req) => {
			try {
				const url = new URL(req.url, 'http://localhost');
				const userId = url.searchParams.get('user_id');
				if (userId) {
					if (!userIdToSockets.has(userId)) userIdToSockets.set(userId, new Set());
					userIdToSockets.get(userId).add(ws);
					ws.on('close', () => {
						const s = userIdToSockets.get(userId);
						if (s) { s.delete(ws); if (s.size === 0) userIdToSockets.delete(userId); }
					});
				}
			} catch {}
		});

		try {
			await resolveBotUsername();
			await startTunnel();
			console.log('Final Mini App URL:', getMiniAppUrl());
		} catch (e) {
			console.error('Startup error:', e);
		}
	});
}

bootstrap(); 