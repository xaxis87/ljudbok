import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import StorytelClient from './storytelApi';
import crypto from 'crypto';
import dotenv from 'dotenv';
import fastifyJWT from '@fastify/jwt';
import fastifyCors from '@fastify/cors';
import fs from 'fs';
import path from 'path';
import axios from 'axios';

// Extend JWT user type
interface JWTUser {
    storytelToken: string;
    jwt: string;
    email: string;
}

// Extend FastifyRequest with user property
declare module '@fastify/jwt' {
    interface FastifyJWT {
        user: JWTUser;
    }
}

// Extend Fastify instance with authenticate decorator
declare module 'fastify' {
    interface FastifyInstance {
        authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    }
}


dotenv.config({
    quiet: true
});

const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-this-in-production';
const DOWNLOADS_DIR = process.env.IS_ELECTRON ? ''+process.env.DOWNLOAD_PATH : path.join(__dirname, 'downloads');
const METADATA_FILE = path.join(DOWNLOADS_DIR, '.metadata.json');

// Ensure downloads directory exists
if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// Helper to read/write metadata mapping bookId to filename
function readMetadata(): Record<string, string> {
    try {
        if (fs.existsSync(METADATA_FILE)) {
            return JSON.parse(fs.readFileSync(METADATA_FILE, 'utf-8'));
        }
    } catch (error) {
        console.error('Error reading metadata:', error);
    }
    return {};
}

function writeMetadata(metadata: Record<string, string>) {
    try {
        fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2));
    } catch (error) {
        console.error('Error writing metadata:', error);
    }
}

function addToMetadata(bookId: string, filename: string) {
    const metadata = readMetadata();
    metadata[bookId] = filename;
    writeMetadata(metadata);
}

function removeFromMetadata(bookId: string) {
    const metadata = readMetadata();
    delete metadata[bookId];
    writeMetadata(metadata);
}

const activeDownloads = new Map<string, {
    controller: AbortController,
    writer: fs.WriteStream,
    filePath: string
}>();

const fastify = Fastify({ logger: process.env.NODE_ENV !== 'production' });

// Register plugins
fastify.register(fastifyCors, {
    origin: 'http://localhost:3000',
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
});

fastify.register(fastifyJWT, {
    secret: JWT_SECRET
});
// Authentication decorator
fastify.decorate('authenticate', async function (request: FastifyRequest, reply: FastifyReply) {
    try {
        await request.jwtVerify();
    } catch (err) {
        reply.code(401).send({ error: 'Not authenticated' });
    }
});

// Route per login
fastify.post<{
    Body: { email: string; password: string };
}>('/api/login', async (request, reply) => {
    try {
        const { email, password } = request.body;

        if (!email || !password) {
            return reply.code(400).send({ error: 'Email and password required' });
        }

        const storytelClient = new StorytelClient();
        const loginData = await storytelClient.login(email, password);

        // Create JWT token with storytel client data
        const token = fastify.jwt.sign({
            storytelToken: loginData.accountInfo.singleSignToken,
            jwt: loginData.accountInfo.jwt,
            email: email
        });

        reply.send({ success: true, message: 'Login successful', token });
    } catch (error: any) {
        reply.code(401).send({ error: error.message });
    }
});

// Route per logout
fastify.post('/api/logout', async (_request, reply) => {
    reply.send({ success: true, message: 'Logged out successfully' });
});

// Route per ottenere bookshelf
fastify.get('/api/bookshelf', {
    preHandler: fastify.authenticate
}, async (request, reply) => {
    try {
        const storytelClient = new StorytelClient();

        storytelClient.loginData = {
            accountInfo: {
                singleSignToken: request.user.storytelToken,
                jwt: ''
            }
        };

        const bookshelf = await storytelClient.getBookshelf();
        reply.send(bookshelf);
    } catch (error: any) {
        reply.code(500).send({ error: error.message });
    }
});

// Route per ottenere stream URL
fastify.post<{
    Body: { bookId: string };
}>('/api/stream', {
    preHandler: fastify.authenticate
}, async (request, reply) => {
    try {
        const { bookId } = request.body;
        const localFilePath = findDownloadedFile(bookId);

        // Check if file exists locally
        if (localFilePath && fs.existsSync(localFilePath)) {
            // Use custom protocol for Electron, fallback to HTTP for browser
            const isElectron = request.headers['user-agent']?.includes('Electron') ||
                              process.env.IS_ELECTRON === 'true';

            if (isElectron) {
                // Use file:// protocol directly for Electron
                console.log(localFilePath);
                reply.send({
                    streamUrl: `file://${localFilePath}`,
                    remote: false
                });
            } else {
                // Use HTTP endpoint for browser
                const protocol = request.protocol;
                const host = request.hostname;
                const port = (request.socket as any).localPort || 3001;
                const baseUrl = `${protocol}://${host}:${port}`;

                reply.send({
                    streamUrl: `${baseUrl}/api/local-stream/${bookId}`,
                    remote: false
                });
            }
        } else {
            const storytelClient = new StorytelClient();
            // Set the login data from JWT token
            storytelClient.loginData = {
                accountInfo: {
                    singleSignToken: request.user.storytelToken,
                    jwt: ''
                }
            };
            const streamUrl = await storytelClient.getStreamUrl(bookId);
            reply.send({ streamUrl, remote: true });
        }
    } catch (error: any) {
        reply.code(500).send({ error: error.message });
    }
});

// Route per salvare bookmark
fastify.post<{
    Params: { consumableId: string };
    Body: { position: number; note: string };
}>('/api/bookmarks/:consumableId', {
    preHandler: fastify.authenticate
}, async (request, reply) => {
    try {
        const { consumableId } = request.params;
        const { position, note } = request.body;

        const storytelClient = new StorytelClient();
        // Set the login data from JWT token
        storytelClient.loginData = {
            accountInfo: {
                jwt: request.user.jwt,
                singleSignToken: ''
            }
        };

        await storytelClient.setBookmark(consumableId, position, note);

        reply.send({ success: true, message: 'Bookmark saved' });
    } catch (error: any) {
        reply.code(500).send({ error: error.message });
    }
});

fastify.delete<{
    Params: { consumableId: string; bookmarkId: string };
}>('/api/bookmarks/:consumableId/:bookmarkId', {
    preHandler: fastify.authenticate
}, async (request, reply) => {
    try {
        const { consumableId, bookmarkId } = request.params;
        const storytelClient = new StorytelClient();
        // Set the login data from JWT token
        storytelClient.loginData = {
            accountInfo: {
                jwt: request.user.jwt,
                singleSignToken: ''
            }
        };

        await storytelClient.deleteBookmark(consumableId, bookmarkId);

        reply.send({ success: true, message: 'Bookmark removed' });
    } catch (error: any) {
        reply.code(500).send({ error: error.message });
    }
});

fastify.put<{
    Params: { consumableId: string; bookmarkId: string };
    Body: any;
}>('/api/bookmarks/:consumableId/:bookmarkId', {
    preHandler: fastify.authenticate
}, async (request, reply) => {
    try {
        const { consumableId, bookmarkId } = request.params;
        const storytelClient = new StorytelClient();
        // Set the login data from JWT token
        storytelClient.loginData = {
            accountInfo: {
                jwt: request.user.jwt,
                singleSignToken: ''
            }
        };

        await storytelClient.updateBookmark(consumableId, bookmarkId, request.body);

        reply.send({ success: true, message: 'Bookmark removed' });
    } catch (error: any) {
        reply.code(500).send({ error: error.message });
    }
});

fastify.get('/api/bookmark-positional', {
    preHandler: fastify.authenticate
}, async (request, reply) => {
    try {
        const storytelClient = new StorytelClient();
        // Set the login data from JWT token
        storytelClient.loginData = {
            accountInfo: {
                jwt: request.user.jwt,
                singleSignToken: ''
            }
        };

        const bookmarks = await storytelClient.getBookmarkPositional();
        reply.send(bookmarks);
    } catch (error: any) {
        reply.code(500).send({ error: error.message });
    }
});

fastify.get<{
    Params: { consumableId: string };
}>('/api/bookmark-positional/:consumableId', {
    preHandler: fastify.authenticate
}, async (request, reply) => {
    try {
        const { consumableId } = request.params;

        const storytelClient = new StorytelClient();
        // Set the login data from JWT token
        storytelClient.loginData = {
            accountInfo: {
                jwt: request.user.jwt,
                singleSignToken: ''
            }
        };

        const bookmarks = await storytelClient.getBookmarkPositional(consumableId);
        reply.send(bookmarks);
    } catch (error: any) {
        reply.code(500).send({ error: error.message });
    }
});

fastify.put<{
    Params: { consumableId: string };
    Body: { position: number };
}>('/api/bookmark-positional/:consumableId', {
    preHandler: fastify.authenticate
}, async (request, reply) => {
    try {
        const { consumableId } = request.params;
        const { position } = request.body;

        const storytelClient = new StorytelClient();
        // Set the login data from JWT token
        storytelClient.loginData = {
            accountInfo: {
                jwt: request.user.jwt,
                singleSignToken: ''
            }
        };

        const deviceId = process.env.DEVICE_ID || crypto.randomUUID().toUpperCase();
        const updated = await storytelClient.updateBookmarkPositional(consumableId, position, deviceId);
        reply.send(updated);
    } catch (error: any) {
        reply.code(500).send({ error: error.message });
    }
});

fastify.get<{
    Params: { consumableId: string };
}>('/api/bookmarks/:consumableId', {
    preHandler: fastify.authenticate
}, async (request, reply) => {
    try {
        const storytelClient = new StorytelClient();
        const { consumableId } = request.params;

        // Set the login data from JWT token
        storytelClient.loginData = {
            accountInfo: {
                jwt: request.user.jwt,
                singleSignToken: ''
            }
        };

        const bookmarks = await storytelClient.getBookmark(consumableId);
        reply.send(bookmarks);
    } catch (error: any) {
        reply.code(500).send({ error: error.message });
    }
});

fastify.get<{
    Params: { consumableId: string };
}>('/api/bookmetadata/:consumableId', {
    preHandler: fastify.authenticate
}, async (request, reply) => {
    try {
        const { consumableId } = request.params;
        const storytelClient = new StorytelClient();

        storytelClient.loginData = {
            accountInfo: {
                jwt: request.user.jwt,
                singleSignToken: ''
            }
        };
        const bookInfoContent = await storytelClient.getPlayBookMetaData(consumableId);
        reply.send(bookInfoContent);
    } catch (error: any) {
        reply.code(500).send({ error: error.message });
    }
});

// Route per controllare stato autenticazione
fastify.get('/api/auth/status', async (request, reply) => {
    try {
        await request.jwtVerify();
        reply.send({ authenticated: true });
    } catch (err) {
        reply.send({ authenticated: false });
    }
});

fastify.get<{
    Querystring: { lang?: string };
}>('/api/translations', async (request, reply) => {
    try {
        const { lang } = request.query;

        if (lang === 'it') {
            const translations = await import('./locales/it.json');
            reply.send(translations.default);
        } else if (lang === 'en') {
            const translations = await import('./locales/en.json');
            reply.send(translations.default);
        } else {
            const translationsIt = await import('./locales/it.json');
            const translationsEn = await import('./locales/en.json');
            reply.send({
                it: translationsIt.default,
                en: translationsEn.default
            });
        }
    } catch (error: any) {
        reply.code(500).send({ error: 'Failed to load translations' });
    }
});

// Helper function to sanitize filename
function sanitizeFilename(filename: string): string {
    // Remove invalid characters for filenames
    return filename
        .replace(/[/\\:*?"<>|]/g, '') // Remove invalid chars
        .replace(/\s+/g, ' ') // Replace multiple spaces with single space
        .trim()
        .substring(0, 200); // Limit length to avoid filesystem issues
}

// Helper function to find downloaded file by bookId or title/author
function findDownloadedFile(bookId: string, title?: string, author?: string): string | null {
    try {
        // First check metadata for exact match
        const metadata = readMetadata();
        if (metadata[bookId]) {
            const metadataPath = path.join(DOWNLOADS_DIR, metadata[bookId]);
            if (fs.existsSync(metadataPath)) {
                return metadataPath;
            }
        }

        const files = fs.readdirSync(DOWNLOADS_DIR);

        // Try to find by title and author if provided
        if (title && author) {
            const expectedFilename = `${sanitizeFilename(`${title} - ${author}`)}.mp3`;
            const exactMatch = files.find(file => file === expectedFilename);
            if (exactMatch) {
                return path.join(DOWNLOADS_DIR, exactMatch);
            }
        } else if (title) {
            const expectedFilename = `${sanitizeFilename(title)}.mp3`;
            const exactMatch = files.find(file => file === expectedFilename);
            if (exactMatch) {
                return path.join(DOWNLOADS_DIR, exactMatch);
            }
        }

        // Fallback: Look for old format with [bookId].mp3 or bookId.mp3 for backward compatibility
        const matchingFile = files.find(file =>
            file === `${bookId}.mp3` || file.endsWith(`[${bookId}].mp3`)
        );
        return matchingFile ? path.join(DOWNLOADS_DIR, matchingFile) : null;
    } catch (error) {
        return null;
    }
}

// Route per scaricare il file audio da remoto
fastify.post<{
    Body: { bookId: string; title?: string; author?: string };
}>('/api/download', {
    preHandler: fastify.authenticate
}, async (request, reply) => {
    try {
        const { bookId, title, author } = request.body;

        // Create a meaningful filename without bookId
        let filename = bookId;
        if (title && author) {
            filename = sanitizeFilename(`${title} - ${author}`);
        } else if (title) {
            filename = sanitizeFilename(title);
        }

        const localFilePath = path.join(DOWNLOADS_DIR, `${filename}.mp3`);

        // Check if already exists (with any filename)
        const existingFile = findDownloadedFile(bookId, title, author);
        if (existingFile && fs.existsSync(existingFile)) {
            return reply.send({ success: true, message: 'File already downloaded', percentage: 100 });
        }

        if (activeDownloads.has(bookId)) {
            return reply.code(409).send({ error: 'Download already in progress' });
        }

        // Get stream URL
        const storytelClient = new StorytelClient();
        storytelClient.loginData = {
            accountInfo: {
                singleSignToken: request.user.storytelToken,
                jwt: ''
            }
        };
        const streamUrl = await storytelClient.getStreamUrl(bookId);

        // Create AbortController for this download
        const controller = new AbortController();
        const writer = fs.createWriteStream(localFilePath);

        // Track this download
        activeDownloads.set(bookId, { controller, writer, filePath: localFilePath });

        try {
            // Download the file
            const response = await axios({
                method: 'GET',
                url: streamUrl,
                responseType: 'stream',
                signal: controller.signal as any
            });

            const totalLength = parseInt(response.headers['content-length'] || '0', 10);
            let downloadedLength = 0;

            response.data.on('data', (chunk: Buffer) => {
                downloadedLength += chunk.length;
                const percentage = totalLength > 0 ? Math.round((downloadedLength / totalLength) * 100) : 0;

                if (percentage % 10 === 0) {
                    fastify.log.info(`Download progress for ${bookId}: ${percentage}%`);
                }
            });

            response.data.pipe(writer);

            await new Promise<void>((resolve, reject) => {
                writer.on('finish', () => resolve());
                writer.on('error', reject);
                controller.signal.addEventListener('abort', () => {
                    reject(new Error('Download cancelled'));
                });
            });

            // Clean up
            activeDownloads.delete(bookId);

            // Add to metadata for future lookups
            addToMetadata(bookId, `${filename}.mp3`);

            reply.send({ success: true, message: 'Download completed', percentage: 100 });
        } catch (error: any) {
            // Clean up on error
            activeDownloads.delete(bookId);

            // Remove partial file
            if (fs.existsSync(localFilePath)) {
                fs.unlinkSync(localFilePath);
            }

            if (error.message === 'Download cancelled') {
                reply.code(499).send({ error: 'Download cancelled' });
            } else {
                throw error;
            }
        }
    } catch (error: any) {
        reply.code(500).send({ error: error.message });
    }
});

// Route per cancellare download in corso
fastify.delete<{
    Params: { bookId: string };
}>('/api/download/:bookId', {
    preHandler: fastify.authenticate
}, async (request, reply) => {
    try {
        const { bookId } = request.params;

        const download = activeDownloads.get(bookId);
        if (!download) {
            return reply.send({ error: 'No active download found' });
        }

        // Abort the download
        download.controller.abort();

        // Close the writer stream
        download.writer.end();
        download.writer.destroy();

        // Wait a bit for the writer to close
        await new Promise(resolve => setTimeout(resolve, 100));

        // Remove partial file
        try {
            if (fs.existsSync(download.filePath)) {
                fs.unlinkSync(download.filePath);
            }
        } catch (err) {
            // File might be locked, ignore
            console.error('Could not delete partial file:', err);
        }

        // Clean up
        activeDownloads.delete(bookId);

        reply.send({ success: true, message: 'Download cancelled' });
    } catch (error: any) {
        console.error('Error cancelling download:', error);
        reply.code(500).send({ error: error.message });
    }
});

fastify.get<{ Params: { bookId: string } }>('/api/local-stream/:bookId', async (request, reply) => {
    try {
        const { bookId } = request.params;
        const filePath = findDownloadedFile(bookId);

        if (!filePath || !fs.existsSync(filePath)) {
            return reply.code(404).send({ error: 'File not found' });
        }

        const stat = fs.statSync(filePath);
        const range = request.headers.range;

        if (range) {
            const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
            const start = parseInt(startStr, 10);
            const end = endStr ? parseInt(endStr, 10) : stat.size - 1;

            if (start >= stat.size || end >= stat.size) {
                reply
                    .code(416)
                    .header('Content-Range', `bytes */${stat.size}`)
                    .send();
                return;
            }

            const chunkSize = (end - start) + 1;
            const fileStream = fs.createReadStream(filePath, { start, end });

            reply
                .code(206) // partial content
                .header('Content-Range', `bytes ${start}-${end}/${stat.size}`)
                .header('Accept-Ranges', 'bytes')
                .header('Content-Length', chunkSize)
                .header('Content-Type', 'audio/mpeg')
                .send(fileStream);
            return reply;
        } else {
            const fileStream = fs.createReadStream(filePath);
            reply
                .header('Content-Length', stat.size)
                .header('Content-Type', 'audio/mpeg')
                .header('Accept-Ranges', 'bytes')
                .send(fileStream);
            return reply;
        }
    } catch (error: any) {
        reply.code(500).send({ error: error.message });
    }
});

fastify.get<{
    Params: { bookId: string };
}>('/api/download/:bookId', {
    preHandler: fastify.authenticate
}, async (request, reply) => {
    try {
        const { bookId } = request.params;
        const localFilePath = findDownloadedFile(bookId);

        if (!localFilePath || !fs.existsSync(localFilePath)) {
            return reply.code(404).send({ error: 'File not found' });
        }

        const stream = fs.createReadStream(localFilePath);
        reply.type('audio/mpeg').send(stream);
    } catch (error: any) {
        reply.code(500).send({ error: error.message });
    }
});

// Route per verificare lo stato del download
fastify.get<{
    Params: { bookId: string };
}>('/api/download-status/:bookId', {
    preHandler: fastify.authenticate
}, async (request, reply) => {
    try {
        const { bookId } = request.params;
        const localFilePath = findDownloadedFile(bookId);

        const exists = localFilePath !== null && fs.existsSync(localFilePath);
        reply.send({ downloaded: exists });
    } catch (error: any) {
        reply.code(500).send({ error: error.message });
    }
});

// Route per eliminare file scaricato
fastify.delete<{
    Params: { bookId: string };
}>('/api/downloaded-file/:bookId', {
    preHandler: fastify.authenticate
}, async (request, reply) => {
    try {
        const { bookId } = request.params;
        const localFilePath = findDownloadedFile(bookId);

        if (!localFilePath || !fs.existsSync(localFilePath)) {
            return reply.code(404).send({ error: 'File not found' });
        }

        // Delete the file
        fs.unlinkSync(localFilePath);

        // Remove from metadata
        removeFromMetadata(bookId);

        reply.send({ success: true, message: 'File deleted successfully' });
    } catch (error: any) {
        reply.code(500).send({ error: error.message });
    }
});

export default fastify;
