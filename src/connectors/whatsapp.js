/**
 * WhatsApp Connector Module
 * Handles WhatsApp authentication, connection, and messaging
 */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');

class WhatsAppConnector {
    constructor() {
        this.sock = null;
        this.onQRCallback = null;
        this.onConnectedCallback = null;
        this.onDisconnectedCallback = null;
        this.onDisconnectedCallback = null;
        this.onMessageUpdateCallback = null;
        this.onPresenceUpdateCallback = null;
        this.onRawReceiptCallback = null;
        this.trackedJids = new Set(); // Track multi-device JIDs (including LID format)
        this.lastQR = null; // Store the last QR code for page reloads
    }

    /**
     * Initialize WhatsApp connection
     */
    async connect() {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info');
        
        // Get latest Baileys version
        const { version } = await fetchLatestBaileysVersion();

        this.sock = makeWASocket({
            auth: state,
            version,
            printQRInTerminal: false,
            browser: ['Careless Whisper', 'Chrome', '10.0'],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            markOnlineOnConnect: false,
        });

        this.sock.ev.on('creds.update', saveCreds);

        this.sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                this.lastQR = qr; // Store the QR code
                console.log('\n📱 QR CODE - Scan this with WhatsApp:\n');
                qrcode.generate(qr, { small: true });
                console.log('\n');
                if (this.onQRCallback) {
                    this.onQRCallback(qr);
                }
            }

            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                
                console.log('Connection closed. Status:', statusCode);
                
                if (this.onDisconnectedCallback) {
                    this.onDisconnectedCallback();
                }

                if (shouldReconnect) {
                    // Exponential backoff: wait longer between retries
                    const retryDelay = Math.min(30000, 3000 * Math.pow(2, this.retryCount || 0));
                    this.retryCount = (this.retryCount || 0) + 1;

                    console.log(`Connection closed. Retrying in ${retryDelay / 1000}s... (attempt ${this.retryCount})`);
                    setTimeout(() => this.connect(), retryDelay);
                } else {
                    console.log('Logged out. Not reconnecting automatically.');
                }
            } else if (connection === 'open') {
                this.retryCount = 0; // Reset on successful connection
                this.lastQR = null; // Clear QR code on successful connection
                if (this.onConnectedCallback) {
                    this.onConnectedCallback({
                        id: this.sock.user?.id,
                        name: this.sock.user?.name
                    });
                }
            }
        });

        this.sock.ev.on('messages.update', (updates) => {
            if (this.onMessageUpdateCallback) {
                this.onMessageUpdateCallback(updates);
            }
        });

        // Listen for raw receipts to catch 'inactive' type from Android devices
        // Baileys ignores these by default, but they're critical for Android activity detection
        this.sock.ws.on('CB:receipt', (node) => {
            if (this.onRawReceiptCallback) {
                this.onRawReceiptCallback(node);
            }
        });

        this.sock.ev.on('presence.update', (update) => {
            // Track multi-device JIDs from presence updates
            if (update.presences) {
                for (const [jid, presenceData] of Object.entries(update.presences)) {
                    if (presenceData && presenceData.lastKnownPresence) {
                        this.trackedJids.add(jid);
                        console.log(`[MULTI-DEVICE] Tracking JID: ${jid}`);
                    }
                }
            }
            if (this.onPresenceUpdateCallback) {
                this.onPresenceUpdateCallback(update);
            }
        });

        return this.sock;
    }

    /**
     * Send a silent delete probe (most covert method - works best for Android)
     */
    async sendDeleteProbe(targetNumber) {
        if (!this.sock) {
            throw new Error('WhatsApp not connected');
        }

        const cleanNumber = targetNumber.replace(/^\+/, '').replace(/^00/, '');
        const jid = `${cleanNumber}@s.whatsapp.net`;

        // Add to tracked JIDs
        this.trackedJids.add(jid);

        // Generate random message ID that doesn't exist
        const prefixes = ['3EB0', 'BAE5', 'F1D2', 'A9C4', '7E8B', 'C3F9', '2D6A'];
        const randomPrefix = prefixes[Math.floor(Math.random() * prefixes.length)];
        const randomSuffix = Math.random().toString(36).substring(2, 10).toUpperCase();
        const randomMsgId = randomPrefix + randomSuffix;

        const result = await this.sock.sendMessage(jid, {
            delete: {
                remoteJid: jid,
                fromMe: true,
                id: randomMsgId
            }
        });

        // CRITICAL: Record startTime AFTER sending to only measure receipt time
        const startTime = Date.now();

        // Subscribe to presence updates for this target
        await this.sock.presenceSubscribe(jid);

        return {
            messageId: result.key.id,
            startTime,
            target: cleanNumber,
            jid
        };
    }

    /**
     * Send a silent probe message (reaction method - alternative to delete probe)
     */
    async sendProbe(targetNumber) {
        if (!this.sock) {
            throw new Error('WhatsApp not connected');
        }

        const cleanNumber = targetNumber.replace(/^\+/, '').replace(/^00/, '');
        const jid = `${cleanNumber}@s.whatsapp.net`;

        // Add to tracked JIDs
        this.trackedJids.add(jid);

        // Generate random message ID
        const prefixes = ['3EB0', 'BAE5', 'F1D2', 'A9C4', '7E8B', 'C3F9', '2D6A'];
        const randomPrefix = prefixes[Math.floor(Math.random() * prefixes.length)];
        const randomSuffix = Math.random().toString(36).substring(2, 10).toUpperCase();
        const randomMsgId = randomPrefix + randomSuffix;

        const result = await this.sock.sendMessage(jid, {
            react: {
                text: '👍',
                key: {
                    remoteJid: jid,
                    id: randomMsgId
                }
            }
        });

        // CRITICAL: Record startTime AFTER sending to only measure receipt time
        const startTime = Date.now();

        // Subscribe to presence updates for this target
        await this.sock.presenceSubscribe(jid);

        return {
            messageId: result.key.id,
            startTime,
            target: cleanNumber,
            jid
        };
    }

    /**
     * Check if WhatsApp is connected
     */
    isConnected() {
        return this.sock !== null && this.sock.user !== undefined;
    }

    /**
     * Get current user info
     */
    getUserInfo() {
        if (!this.sock || !this.sock.user) {
            return null;
        }
        return {
            id: this.sock.user.id,
            name: this.sock.user.name
        };
    }

    /**
     * Set callback for QR code generation
     */
    onQR(callback) {
        this.onQRCallback = callback;
    }

    /**
     * Set callback for successful connection
     */
    onConnected(callback) {
        this.onConnectedCallback = callback;
    }

    /**
     * Set callback for disconnection
     */
    onDisconnected(callback) {
        this.onDisconnectedCallback = callback;
    }

    /**
     * Set callback for message updates (receipts)
     */
    onMessageUpdate(callback) {
        this.onMessageUpdateCallback = callback;
    }

    /**
     * Set callback for presence updates
     */
    onPresenceUpdate(callback) {
        this.onPresenceUpdateCallback = callback;
    }

    /**
     * Set callback for raw receipt handling (critical for Android inactive receipts)
     */
    onRawReceipt(callback) {
        this.onRawReceiptCallback = callback;
    }

    /**
     * Get tracked JIDs (including multi-device LID format)
     */
    getTrackedJids() {
        return Array.from(this.trackedJids);
    }

    /**
     * Check if WhatsApp is connected
     */
    isConnected() {
        return this.sock && this.sock.user;
    }

    /**
     * Get user information
     */
    getUserInfo() {
        if (this.sock && this.sock.user) {
            return {
                id: this.sock.user.id,
                name: this.sock.user.name
            };
        }
        return null;
    }

    /**
     * Get the last generated QR code
     */
    getLastQR() {
        return this.lastQR;
    }

    /**
     * Logout and clear authentication
     */
    async logout() {
        try {
            // Close the socket connection
            if (this.sock) {
                await this.sock.logout();
                this.sock = null;
            }

            // Delete auth_info folder
            const authPath = path.join(__dirname, '..', '..', 'auth_info');
            if (fs.existsSync(authPath)) {
                fs.rmSync(authPath, { recursive: true, force: true });
                console.log('Auth folder deleted');
            }

            // Reconnect to show QR code
            setTimeout(() => {
                this.connect();
            }, 1000);
        } catch (error) {
            console.error('Logout error:', error);
            // Still try to reconnect even if logout fails
            setTimeout(() => {
                this.connect();
            }, 1000);
        }
    }
}

module.exports = WhatsAppConnector;
