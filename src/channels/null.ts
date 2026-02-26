import { Channel } from '../types.js';

/**
 * No-op channel used when WhatsApp is disabled.
 * All call sites (sendMessage, sendImage, setTyping, etc.) work
 * without null checks — messages are simply discarded.
 */
export class NullChannel implements Channel {
  name = 'null';

  async connect(): Promise<void> { /* no-op */ }
  async sendMessage(_jid: string, _text: string): Promise<void> { /* no-op */ }
  async sendImage(_jid: string, _image: Buffer, _caption?: string): Promise<void> { /* no-op */ }
  async setTyping(_jid: string, _isTyping: boolean): Promise<void> { /* no-op */ }
  isConnected(): boolean { return true; }
  ownsJid(_jid: string): boolean { return true; }
  async disconnect(): Promise<void> { /* no-op */ }
  async syncGroupMetadata(_force: boolean): Promise<void> { /* no-op */ }
}
