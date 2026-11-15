import type { Stream } from '@agentclientprotocol/sdk';
type WireMessage=Stream['writable'] extends WritableStream<infer T>?T:never;

/** SDK handlers can resolve before their response writes finish. Count raw RPC
 * requests before SDK dispatch and release only after the underlying response
 * write finishes. This also covers unknown methods and cancelled channels. */
export function boundedIngress(stream: Stream, close: (reason: string) => void, observe?:{before(id:unknown,message:Record<string,unknown>):Record<string,unknown>;written(id:unknown,success:boolean):void}): Stream {
  const pending = new Map<string, number>(); let pendingBytes = 0; let closed = false;
  const key = (id:unknown) => JSON.stringify([typeof id,id]);
  const response = (value:Record<string, unknown>) => !('method' in value) && 'id' in value && ('result' in value || 'error' in value);
  const terminate = (reason:string) => { if(closed)return;closed=true;close(reason); };
  return {
    writable: new WritableStream({ async write(message) {
      const writer = stream.writable.getWriter();
      try {
        const record=message as Record<string,unknown>;
        const outgoing=(response(record)?observe?.before(record.id,record)??message:message) as WireMessage;
        try {await writer.write(outgoing);if(response(record))observe?.written(record.id,true);}catch(error){if(response(record))observe?.written(record.id,false);throw error;}
        if('id' in message&&response(message)){const id=key(message.id);const bytes=pending.get(id);if(bytes!==undefined){pending.delete(id);pendingBytes-=bytes;}}
      } finally { writer.releaseLock(); }
    } }),
    readable: stream.readable.pipeThrough(new TransformStream({ transform(message, controller) {
      if (closed) return;
      const record = message as Record<string, unknown>;
      const notification = record.jsonrpc==='2.0' && typeof record.method==='string' && !('id' in record);
      if (!response(record) && !notification) {
        const valid=record.jsonrpc==='2.0' && typeof record.method==='string' && (record.id===null||typeof record.id==='string'||typeof record.id==='number'&&Number.isFinite(record.id));
        const id=key(record.id);const bytes=Buffer.byteLength(JSON.stringify(message));
        if(!valid||pending.has(id)){terminate('Invalid or duplicate ACP request closed its managed connection.');controller.terminate();return;}
        if(pending.size>=64||pendingBytes+bytes>2*1024*1024){terminate('ACP control ingress budget exceeded; managed execution was stopped.');controller.terminate();return;}
        pending.set(id,bytes);pendingBytes+=bytes;
      }
      controller.enqueue(message);
    } }))
  };
}
