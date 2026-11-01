import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';

// Each bot is a separate process. A nonblocking exclusive lock prevents lost claims.
// Recover only a demonstrably dead local process, never an elapsed-time lease.
export class SettlementStore {
    constructor(directory) { this.directory = directory; }
    transaction(change) {
        mkdirSync(this.directory, { recursive: true });
        const lock = path.join(this.directory, 'settlement.lock');
        let fd;
        try { fd = openSync(lock, 'wx'); }
        catch (error) {
            if (error.code !== 'EEXIST') throw error;
            try {
                const owner = JSON.parse(readFileSync(lock, 'utf8'));
                if (Number.isInteger(owner.pid) && owner.pid > 0) {
                    try { process.kill(owner.pid, 0); }
                    catch (probe) { if (probe.code === 'ESRCH') unlinkSync(lock); }
                }
            } catch { /* A live writer may not yet have written its PID. Retry next tick. */ }
            return null;
        }
        try {
            writeFileSync(fd, JSON.stringify({ pid: process.pid }), 'utf8');
            const file = path.join(this.directory, 'settlement.json');
            let board;
            try { board = JSON.parse(readFileSync(file, 'utf8')); }
            catch (error) {
                if (error.code !== 'ENOENT') throw error; // Never erase an unreadable board.
                board = { version: 1, base: null, members: {}, claims: {}, requests: {}, cooldowns: {}, events: [] };
            }
            const result = change(board);
            const temporary = `${file}.${process.pid}.tmp`;
            writeFileSync(temporary, JSON.stringify(board, null, 2), 'utf8');
            renameSync(temporary, file);
            return result;
        } finally { closeSync(fd); unlinkSync(lock); }
    }
}
