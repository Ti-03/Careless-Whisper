/**
 * WhatsApp Connector Module
 * Handles WhatsApp authentication, connection, and messaging
 */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');

class WhatsAppConnector {
    constructor() {
        this.sock = null;
        this.onQRCallback = null;
        this.onConnectedCallback = null;
        this.onDisconnectedCallback = null;
        this.onMessageUpdateCallback = null;
    }

    /**
     * Initialize WhatsApp connection
     */
    async connect() {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info');
        
        this.sock = makeWASocket({
            auth: state,
        });
        
        this.sock.ev.on('creds.update', saveCreds);
        
        this.sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr && this.onQRCallback) {
                this.onQRCallback(qr);
            }
            
            if (connection === 'close') {
                if (this.onDisconnectedCallback) {
                    this.onDisconnectedCallback();
                }
                
                // Auto-reconnect after 3 seconds
                setTimeout(() => this.connect(), 3000);
            } else if (connection === 'open') {
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
        
        return this.sock;
    }

    /**
     * Send a silent probe message (invalid reaction)
     */
    async sendProbe(targetNumber) {
        if (!this.sock) {
            throw new Error('WhatsApp not connected');
        }
        
        const startTime = Date.now();
        const cleanNumber = targetNumber.replace(/^\+/, '').replace(/^00/, '');
        const jid = `${cleanNumber}@s.whatsapp.net`;
        
        const result = await this.sock.sendMessage(jid, {
            react: {
                text: '👍',
                key: {
                    remoteJid: jid,
                    id: 'INVALID_' + Math.random().toString(36).substring(7)
                }
            }
        });
        
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
}

module.exports = WhatsAppConnector;
