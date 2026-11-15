import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { AorkError } from '@aork/sdk';
import { INPUT_LIMITS } from '@aork/contracts/input';
import type { AttachmentReference, NegotiatedInput, PromptContent } from '@aork/contracts/input';
import type { WorkspaceService } from '@aork/contracts/workspace';
/** Read only through the installed Workspace service; accepted content is copied, never reread at dispatch. */
export async function captureInput(workspaces:WorkspaceService,workspaceId:string,text:string,attachments:readonly AttachmentReference[],negotiated:NegotiatedInput|undefined){
  const content:PromptContent[]=[{type:'text',text}];const snapshots=[];let total=Buffer.byteLength(text);
  const workspace=workspaces.requireOpenWorkspace(workspaceId);
  for(const attachment of attachments){
    if(!negotiated||(attachment.kind==='text'?!negotiated.prompt.embeddedContext:!negotiated.prompt[attachment.kind]))throw new AorkError('RUN_INPUT_UNSUPPORTED','This Run does not support that attachment input',409);
    const bytes=await workspaces.files.download(workspaceId,attachment.path);
    if(bytes.byteLength>INPUT_LIMITS.attachmentBytes||total+bytes.byteLength>INPUT_LIMITS.totalBytes)throw new AorkError('RUN_INPUT_TOO_LARGE','Attachments exceed 128 KiB per file or 256 KiB per input',413);total+=bytes.byteLength;
    const buffer=Buffer.from(bytes);const uri=pathToFileURL(join(workspace.directory,attachment.path)).href;
    if(attachment.kind==='text'){
      let value:string;try{value=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(value.includes('\0'))throw Error();}catch{throw new AorkError('RUN_INPUT_FORMAT_UNSUPPORTED','Text attachment must contain valid UTF-8 text without NUL',415);}
      content.push({type:'resource',resource:{uri,mimeType:'text/plain',text:value}});
    }else{
      const mimeType=attachment.kind==='image'?(buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':buffer[0]===255&&buffer[1]===216&&buffer[2]===255?'image/jpeg':undefined):(buffer.subarray(0,4).toString()==='RIFF'&&buffer.subarray(8,12).toString()==='WAVE'?'audio/wav':buffer.subarray(0,3).toString()==='ID3'||buffer[0]===255&&(buffer[1]!&224)===224?'audio/mpeg':undefined);
      if(!mimeType)throw new AorkError('RUN_INPUT_FORMAT_UNSUPPORTED','Attachment format is unsupported; use PNG/JPEG images or WAV/MP3 audio',415);
      content.push({type:attachment.kind,mimeType,data:buffer.toString('base64')});
    }
    snapshots.push({...attachment,size:bytes.byteLength,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
  // ACP and durable queues are byte bounded even when Unicode/control characters expand in JSON.
  if(Buffer.byteLength(JSON.stringify(content))>512*1024)throw new AorkError('RUN_INPUT_TOO_LARGE','Encoded input exceeds the 512 KiB ACP content limit',413);
  if(Buffer.byteLength(JSON.stringify(snapshots))>8000)throw new AorkError('RUN_INPUT_TOO_LARGE','Attachment references exceed the supported durable metadata limit',413);
  return{content,attachments:snapshots};
}
