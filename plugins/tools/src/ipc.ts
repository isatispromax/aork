import type { Socket } from 'node:net';
const MAX = 1048576;
/** Private length-prefixed protocol. Reject the advertised length before allocating a frame. */
export function framed(socket: Socket, onFrame: (value: unknown) => void, onFailure: () => void) {
    let pending = Buffer.alloc(0);
    let failed = false;
    let outputFrames = 0;
    const fail = () => { if (failed)
        return; failed = true; socket.destroy(); onFailure(); };
    socket.on('error', fail);
    socket.on('data', (chunk: Buffer) => { if (failed)
        return; if (pending.length + chunk.length > MAX + 4) {
        fail();
        return;
    } pending = Buffer.concat([pending, chunk]); try {
        while (pending.length >= 4) {
            const size = pending.readUInt32BE(0);
            if (size < 2 || size > MAX) {
                fail();
                return;
            }
            if (pending.length < size + 4)
                return;
            const bytes = pending.subarray(4, size + 4);
            pending = pending.subarray(size + 4);
            onFrame(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
        }
    }
    catch {
        fail();
    } });
    return { send(value: unknown) { if (failed || socket.destroyed)
            return false; let bytes: Buffer; try {
            bytes = Buffer.from(JSON.stringify(value));
        }
        catch {
            fail();
            return false;
        } if (bytes.length > MAX || socket.writableLength + bytes.length + 4 > MAX || outputFrames >= 64) {
            fail();
            return false;
        } const frame = Buffer.allocUnsafe(bytes.length + 4); frame.writeUInt32BE(bytes.length); bytes.copy(frame, 4); outputFrames++; socket.write(frame, () => { outputFrames--; }); return true; }, close: fail };
}
