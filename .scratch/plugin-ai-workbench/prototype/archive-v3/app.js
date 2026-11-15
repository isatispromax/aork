/* THROWAWAY UI PROTOTYPE. D is the current layout; ?variant=A|B|C remains backward compatible.
   Question: can users find work, answer real pending requests and continue safely?
   All data and operations are simulated in memory; this is not an Agent client. */
(() => {
'use strict';
const $ = s => document.querySelector(s);
const escape = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths = {
 plus:'M12 5v14M5 12h14', chevron:'m9 5 7 7-7 7', back:'m15 5-7 7 7 7', down:'m6 9 6 6 6-6', close:'m6 6 12 12M18 6 6 18',
 folder:'M3 6h6l2 2h10v11H3V6Z', chat:'M4 4h16v12H9l-5 4V4Z', inbox:'M4 4h16v15H4V4Zm0 9h5l2 3h2l2-3h5',
 file:'M6 3h8l4 4v14H6V3Zm8 0v5h4M9 12h6M9 16h6', settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1M5.6 18.4l2.1-2.1m8.6-8.6 2.1-2.1',
 plug:'M8 3v5m8-5v5M6 8h12v4a6 6 0 0 1-6 6v3M6 12a6 6 0 0 0 6 6', arrow:'m12 19 0-14m-5 5 5-5 5 5',
 stop:'M6 6h12v12H6z', panel:'M3 4h18v16H3zM15 4v16', menu:'M4 6h16M4 12h16M4 18h16', clock:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4v5l3 2',
 check:'m5 12 4 4L19 6', link:'m10 14 4-4M8 16l-2 2a3 3 0 0 1-4-4l5-5a3 3 0 0 1 4 0m2 6a3 3 0 0 0 4 0l5-5a3 3 0 0 0-4-4l-2 2',
 download:'M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4', play:'m8 4 12 8-12 8V4Z', restart:'M4 9a8 8 0 1 1 0 7M4 4v5h5',
 shield:'m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z', attach:'m8 13 7-7a3 3 0 0 1 4 4L9 20a5 5 0 0 1-7-7L13 2', dots:'M5 12h.01M12 12h.01M19 12h.01', info:'M12 11v6m0-10v.1M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z',
 spark:'m12 3 2.3 6.7L21 12l-6.7 2.3L12 21l-2.3-6.7L3 12l6.7-2.3L12 3Z', search:'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 6 6', exit:'M10 4H4v16h6m4-4 4-4-4-4m-5 4h10'
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.file}"/></svg>`;
const button = (label,action,cls='secondary',attrs='') => `<button type="button" class="button ${cls}" data-action="${action}" ${attrs}>${label}</button>`;
const iconButton = (name,label,action,attrs='') => `<button type="button" class="icon-button" aria-label="${escape(label)}" title="${escape(label)}" data-action="${action}" ${attrs}>${icon(name)}</button>`;
const variants = {D:'工作台'};
const themeMedia=window.matchMedia('(prefers-color-scheme: dark)');
const themeQuery=new URLSearchParams(location.search).get('theme');
const initialTheme=['system','light','dark'].includes(themeQuery)?themeQuery:'system';
let timers = new Map();
let toastTimer;
let lastTrigger;
let composing=false;
let renderedViewport=null;
function focusSelector(el) {
 if(!el)return null;if(el.id)return '#'+CSS.escape(el.id);
 if(!el.dataset?.action)return null;
 let selector='[data-action="'+CSS.escape(el.dataset.action)+'"]';
 for(const key of ['id','variant','agent','name','index','view','project','tab','path'])if(el.dataset[key]!==undefined)selector+='[data-'+key+'="'+CSS.escape(el.dataset[key])+'"]';
 if(el.getAttribute('aria-label'))selector+='[aria-label="'+CSS.escape(el.getAttribute('aria-label'))+'"]';
 return selector;
}
const gitSources = {unstaged:'未暂存',staged:'已暂存',branch:'相对主分支',previous:'上一轮'};
const fixtureFile = (path,content) => ({path,name:path.split('/').at(-1),language:({tsx:'TSX',ts:'TypeScript',md:'Markdown',json:'JSON',css:'CSS'})[path.split('.').at(-1)] || '纯文本',content});
function fixtureChange(path,status,before,after) {
 const oldLines=before?before.split('\n'):[],newLines=after?after.split('\n'):[];
 let prefix=0,suffix=0;
 while(prefix<oldLines.length && prefix<newLines.length && oldLines[prefix]===newLines[prefix])prefix++;
 while(suffix<oldLines.length-prefix && suffix<newLines.length-prefix && oldLines[oldLines.length-1-suffix]===newLines[newLines.length-1-suffix])suffix++;
 const rows=[];let oldNumber=1,newNumber=1;
 const row=(type,text)=>({type,text,old:type==='added'?'':oldNumber++,new:type==='removed'?'':newNumber++});
 for(let n=0;n<prefix;n++)rows.push(row('context',oldLines[n]));
 for(let n=prefix;n<oldLines.length-suffix;n++)rows.push(row('removed',oldLines[n]));
 for(let n=prefix;n<newLines.length-suffix;n++)rows.push(row('added',newLines[n]));
 for(let n=oldLines.length-suffix;n<oldLines.length;n++)rows.push(row('context',oldLines[n]));
 return {path,status,before,after,rows,added:rows.filter(r=>r.type==='added').length,removed:rows.filter(r=>r.type==='removed').length,hunk:`@@ -${oldLines.length?1:0},${oldLines.length} +${newLines.length?1:0},${newLines.length} @@`};
}
function demoWorkspaces() {
 const panelBefore=['import { FileTree } from "./FileTree";','','export function WorkspacePanel() {','  return <FileTree />;','}'].join('\n');
 const panelAfter=['import { FileTree } from "./FileTree";','import { WorkspaceTabs } from "./WorkspaceTabs";','','export function WorkspacePanel() {','  return (','    <aside aria-label="工作区文件与 Git 改动">','      <WorkspaceTabs tabs={["files", "git"]} />','      <FileTree />','    </aside>','  );','}'].join('\n');
 const tabs=['type PanelTab = "files" | "git";','','export function WorkspaceTabs({ tabs }: { tabs: PanelTab[] }) {','  return (','    <div role="tablist" aria-label="工作区">','      {tabs.map(tab => <button key={tab} role="tab">{tab}</button>)}','    </div>','  );','}'].join('\n');
 const legacy=['export function LegacyPanel() {','  return <aside>旧版文件入口</aside>;','}'].join('\n');
 const readmeBefore='# Aork 工作台\n\n在项目中组织会话，与 Agent 协作。\n\n## 开发\n\npnpm dev';
 const readmeAfter='# Aork 工作台\n\n在项目中组织会话，与 Agent 协作。\n\n## 工作区面板\n\n右侧查看文件与 Git 改动，文件可以加入下一条输入。\n插件配置集中在设置中。\n\n## 开发\n\npnpm dev';
 const shortcuts='# 工作区快捷键\n\n- 方向键：浏览文件树\n- Enter：预览文件\n- Escape：关闭浮层\n\n这些文件内容是独立的内存示例。';
 const appBefore='import { WorkspacePanel } from "./components/layout/WorkspacePanel";\n\nexport function App() {\n  return <main>会话</main>;\n}';
 const appAfter='import { WorkspacePanel } from "./components/layout/WorkspacePanel";\n\nexport function App() {\n  return <main><section>会话</section><WorkspacePanel /></main>;\n}';
 return [
  {id:'w1',project:'p1',name:'用户访谈',path:'/srv/aork/workspaces/research',files:[fixtureFile('访谈/开发者 01.md','# 开发者访谈 01\n\n主题：多个项目之间切换。\n\n“我想先看到哪个会话正在等待我。”\n\n观察：用户会保留一个长期工作的项目。'),fixtureFile('访谈/开发者 03.md','# 开发者访谈 03\n\n主题：检查 Agent 的修改。\n\n“我会先看改了哪些文件，再决定是否继续。”\n\n观察：文件路径与差异比任务摘要更有帮助。'),fixtureFile('研究背景.md','# 研究背景\n\n目标：理解开发者如何跟进并行会话。\n\n范围：导航、待处理请求、文件检查。\n样本：示例访谈，不代表真实研究结论。')],git:null},
  {id:'w2',project:'p2',name:'aork-ui',path:'/srv/aork/workspaces/aork',files:[fixtureFile('README.md',readmeAfter),fixtureFile('src/App.tsx',appAfter),fixtureFile('src/components/layout/WorkspacePanel.tsx',panelAfter),fixtureFile('src/components/layout/WorkspaceTabs.tsx',tabs),fixtureFile('src/components/layout/FileTree.tsx','type FileEntry = { path: string; name: string };\n\nexport function FileTree({ files = [] }: { files?: FileEntry[] }) {\n  return <ul>{files.map(file => <li key={file.path}>{file.name}</li>)}</ul>;\n}'),fixtureFile('src/styles/workspace.css','.workspace-panel {\n  min-width: 320px;\n  border-left: 1px solid var(--border);\n}\n\n.file-tree { overflow: auto; }'),fixtureFile('docs/shortcuts.md',shortcuts),fixtureFile('package.json','{\n  "name": "aork-workbench-demo",\n  "private": true,\n  "scripts": { "dev": "vite" }\n}'),fixtureFile('.gitignore','node_modules/\ndist/\n.DS_Store')],git:{branch:'feat/workspace-panel',base:'main',status:'ready',sources:{unstaged:[fixtureChange('src/components/layout/WorkspacePanel.tsx','M',panelBefore,panelAfter),fixtureChange('src/components/layout/WorkspaceTabs.tsx','A','',tabs),fixtureChange('src/components/layout/LegacyPanel.tsx','D',legacy,'')],staged:[fixtureChange('README.md','M',readmeBefore,readmeAfter),fixtureChange('docs/shortcuts.md','A','',shortcuts)],branch:[fixtureChange('src/App.tsx','M',appBefore,appAfter),fixtureChange('README.md','M',readmeBefore,readmeAfter),fixtureChange('src/components/layout/WorkspaceTabs.tsx','A','',tabs)],previous:[fixtureChange('src/components/layout/WorkspacePanel.tsx','M',panelAfter.replace('aria-label="工作区文件与 Git 改动"','aria-label="工作区"'),panelAfter),fixtureChange('src/styles/workspace.css','M','.workspace-panel {\n  min-width: 280px;\n  border-left: 1px solid var(--border);\n}\n\n.file-tree { overflow: auto; }','.workspace-panel {\n  min-width: 320px;\n  border-left: 1px solid var(--border);\n}\n\n.file-tree { overflow: auto; }')]}}},
  {id:'w3',project:'p3',name:'每周记录',path:'/srv/aork/workspaces/documents',files:[fixtureFile('本周工作记录.md','# 本周工作记录\n\n## 已完成\n\n- 整理项目导航。\n- 评审右侧文件与 Git 面板。\n\n## 下一步\n\n核对窄屏操作与键盘焦点。')],git:null}
 ];
}
const seed = () => ({
 profiles:{Claude:'Sonnet · 示例',Codex:'默认配置 · 示例'},
 pluginConfig:{files:{showHidden:false},sessions:{showActivity:true},git:{defaultSource:'unstaged'}},
 projects:[{id:'p2',name:'Aork 工作台',kind:'编程',color:'blue'},{id:'p1',name:'用户研究',kind:'研究',color:'sage'},{id:'p3',name:'工作文档',kind:'文档',color:'sand'}],
 workspaces:demoWorkspaces(),
 sessions:[
 {id:'s2',project:'p2',workspace:'w2',title:'整理导航与工作区面板',agent:'Codex',model:'默认配置 · 示例',run:'ready',turn:'completed',unread:false,generation:1,queue:[],paused:false,messages:[{role:'user',text:'简化左侧导航，把插件配置放进设置。右侧做成文件和 Git 改动两个页签，可以看文件内容和逐行差异。'},{role:'tool',text:'已查看 src/components/layout 与 README.md · 内存示例'},{role:'assistant',text:'示例方案已整理：\n\n左侧保留项目、会话、待处理和设置。右侧文件树可以展开目录、搜索名称、预览内容，再把文件加入输入。\n\nGit 改动按未暂存、已暂存、相对主分支和上一轮查看，每个文件显示增删行与差异。当前未暂存有 3 个示例文件。\n\n可以在右侧切换页签，检查这些交互。'}]},
 {id:'s1',project:'p1',workspace:'w1',title:'整理开发者访谈',agent:'Claude',model:'Sonnet · 示例',run:'ready',turn:'waiting',unread:false,generation:1,queue:[],paused:false,messages:[{role:'user',text:'整理这周的开发者访谈，重点关注项目切换、等待 Agent 与检查文件改动。请保留原话出处。'},{role:'assistant',text:'我会先阅读访谈文件，再按导航、待处理和文件检查归纳共同行为。'},{role:'tool',text:'已定位访谈文件 · 等待你的读取许可'}]},
 {id:'s3',project:'p1',workspace:'w1',title:'提炼访谈问题清单',agent:'Claude',model:'Sonnet · 示例',run:'terminated',turn:'completed',unread:true,generation:1,queue:[],paused:false,messages:[{role:'user',text:'帮我列出下次访谈需要追问的问题。'},{role:'assistant',text:'建议先让受访者回顾一次真实工作，再追问：\n\n1. 怎样发现 Agent 在等待输入？\n2. 怎样定位被修改的文件？\n3. 查看差异后，会怎样继续会话？'}]},
 {id:'s4',project:'p3',workspace:'w3',title:'整理本周工作记录',agent:'Claude',model:'Sonnet · 示例',run:'terminated',turn:'interrupted',unread:false,generation:1,queue:[{text:'再整理一份下周计划',attachments:[]}],paused:true,messages:[{role:'user',text:'根据这些工作记录整理一份周报。'},{role:'assistant',text:'我已读完工作记录，正在归纳本周进展。'},{role:'system',text:'连接已中断。已收到的内容仍保留，排队输入尚未继续。'}]}
 ],
 interactions:[{id:'i1',session:'s1',type:'permission',status:'pending',generation:1,title:'允许读取访谈文件吗？',description:'Claude 希望读取当前工作区中的访谈文件，用于整理研究摘要。'}],
 plugins:[{id:'files',name:'文件与工作区',description:'浏览目录、预览文件并加入输入',enabled:true,required:true,icon:'folder'},{id:'sessions',name:'会话与交互',description:'与 Agent 交流，处理权限和结构化请求',enabled:true,required:true,icon:'chat'},{id:'git',name:'Git 改动',description:'按来源查看文件变化与逐行差异',enabled:true,required:false,icon:'link'}]
});
const initialVariant = new URLSearchParams(location.search).get('variant');
const defaultPanelOpen = variant => variant==='D'?window.innerWidth>=1150:variant==='A' && window.innerWidth>=1100;
const initialState = variant => ({...seed(),variant,theme:initialTheme,view:'work',project:'p2',session:'s2',inspector:defaultPanelOpen(variant),panelWide:false,workspaceViews:{},settingsTab:'agents',modal:null,mobileNav:false,drafts:{},attachments:{},events:[],counter:10});
let state = initialState(variants[initialVariant] ? initialVariant : 'D');
if(initialVariant && !variants[initialVariant]){const url=new URL(location.href);url.searchParams.set('variant','D');history.replaceState(null,'',url);}
function resolvedTheme(){return state.theme==='system'?(themeMedia.matches?'dark':'light'):state.theme;}
function setTheme(value){if(!['system','light','dark'].includes(value))return;state.theme=value;const url=new URL(location.href);url.searchParams.set('theme',value);history.replaceState(null,'',url);render();}
const current = () => state.sessions.find(s=>s.id===state.session) || state.sessions[0];
const project = id => state.projects.find(p=>p.id===id);
const workspace = id => state.workspaces.find(w=>w.id===id);
const pending = sid => state.interactions.filter(i=>i.status==='pending' && (!sid || i.session===sid));
const alive = s => s.run==='ready' || s.run==='stopping' || s.run==='unknown';
const canDispatch = s => s.run==='ready' && ['idle','completed','cancelled'].includes(s.turn) && !pending(s.id).length;
function normalizedPath(path) { const parts=[];for(const part of String(path).split('/')){if(!part || part==='.')continue;if(part==='..')parts.pop();else parts.push(part);}return '/'+parts.join('/'); }
function conflictingPath(path, exceptId) { const a=normalizedPath(path);return state.sessions.find(other=>{if(other.id===exceptId || !alive(other))return false;const b=normalizedPath(workspace(other.workspace)?.path);return a===b || a==='/' || b==='/' || a.startsWith(b+'/') || b.startsWith(a+'/');}); }
function conflictingRun(workspaceId, exceptId) { const target=workspace(workspaceId);return target?conflictingPath(target.path,exceptId):null; }

const statusLabel = s => ({waiting:'等你回复',running:'执行中',cancelling:'取消中',completed:'已完成',cancelled:'本轮已停止',interrupted:'已中断',delivery_unknown:'交付不确定',idle:'准备就绪'})[s.turn] || '准备就绪';
const record = (action, detail='') => { state.events.unshift({action,detail,time:new Date().toLocaleTimeString('zh-CN',{hour12:false})}); state.events=state.events.slice(0,24); };
function toast(text) { $('#toast').textContent=text; $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),2800); }
function snapshot() { return {variant:state.variant,theme:state.theme,resolvedTheme:resolvedTheme(),view:state.view,project:state.project,session:state.session,sessions:state.sessions.map(({id,title,workspace,agent,run,turn,generation,queue,paused,unread})=>({id,title,workspace,agent,run,turn,generation,queue,paused,unread})),interactions:state.interactions,plugins:state.plugins,profiles:state.profiles,pluginConfig:state.pluginConfig,workspaceViews:state.workspaceViews,attachments:state.attachments,events:state.events}; }
function cancelTimer(id) { clearTimeout(timers.get(id)); timers.delete(id); }
function invalidate(s,status='cancelled') { state.interactions.forEach(i=>{if(i.session===s.id && i.status==='pending')i.status=status;}); }
function switchSession(id) {
 const s=state.sessions.find(x=>x.id===id); if(!s)return;
 state.session=id;state.project=s.project;state.foldedProjects=(state.foldedProjects||[]).filter(p=>p!==s.project);state.view='work';state.mobileNav=false;s.unread=false;record('打开会话',s.title);render();
}
function startMock(s,text,attachments=[]) {
 cancelTimer(s.id); s.run='ready';s.turn='running';s.unread=false;
 s.messages.push({role:'user',text,attachments});
 const generation=s.generation;
 record('受理输入',`${s.title} · 开始模拟执行`);render();
 timers.set(s.id,setTimeout(()=>{
  if(s.generation!==generation || s.turn!=='running')return;
  s.messages.push({role:'tool',text:'已读取工作区示例文件 · 正在组织回复'});render();
  timers.set(s.id,setTimeout(()=>finishMock(s),3300));
 },1800));
}
function finishMock(s) {
 cancelTimer(s.id); if(s.turn!=='running')return;
 s.turn='completed';
 s.messages.push({role:'assistant',text:workspace(s.workspace)?.git?'本轮示例执行已完成。\n\n导航保留项目、会话、待处理和设置。可以在右侧检查文件内容，或按来源查看 Git 改动，再把相关文件加入下一条输入。\n\n这是内存交互演示，没有读写真实文件，也没有执行 Git 命令。':'本轮示例整理已完成。\n\n• 项目帮助组织长期工作。\n• 待处理只显示需要回应的请求。\n• 文件可从右侧预览，再加入下一条输入。\n\n这是内存交互演示，文件内容不会被改写。'});
 s.unread=!(state.view==='work' && state.session===s.id); record('模拟执行完成',s.title);render();
 if(s.queue.length && !s.paused)timers.set(s.id,setTimeout(()=>dispatchNext(s),2200));
}
function dispatchNext(s) { if(s.paused || !canDispatch(s) || !s.queue.length)return;const next=s.queue.shift();startMock(s,next.text,next.attachments); }
function stopTurn(s) {
 cancelTimer(s.id);invalidate(s);s.paused=true;s.turn='cancelling';record('取消当前轮次',s.title);render();
 timers.set(s.id,setTimeout(()=>{s.turn='cancelled';s.messages.push({role:'system',text:'本轮已停止。运行仍保留工作区占用；你可以继续对话，或结束运行以释放工作区。'});record('本轮停止',s.title);render();},700));
}
function endRun(s) {
 cancelTimer(s.id);invalidate(s);s.paused=true;s.run='terminated';if(['running','waiting','cancelling'].includes(s.turn))s.turn='cancelled';s.generation++;
 s.messages.push({role:'system',text:'运行已结束，工作区占用已释放。已有消息和文件仍保留。'});record('结束运行并释放工作区',s.title);
}
function addRequest(type) {
 const s=current();cancelTimer(s.id);invalidate(s,'expired');s.run='ready';s.turn='waiting';
 const i={id:'i'+(++state.counter),session:s.id,type,status:'pending',generation:s.generation,title:type==='permission'?'允许读取工作区资料吗？':'这次结果采用哪种形式？',description:type==='permission'?'Agent 希望读取当前工作区的资料文件，仅用于本轮任务。':'请确认你希望的交付形式，Agent 会据此继续。'};
 state.interactions.push(i);record('模拟待处理请求',type);state.modal=null;state.view='work';render();
}
function resolveInteraction(id,accepted) {
 const i=state.interactions.find(x=>x.id===id),s=i && state.sessions.find(x=>x.id===i.session);
 if(!i || !s || i.status!=='pending' || i.generation!==s.generation || !alive(s)){toast('请求已失效，请查看当前会话状态。');return;}
 i.status='responded';i.answer=accepted;i.sent=true;record('响应已发送',s.title);
 if(!accepted){s.turn='cancelled';s.paused=true;s.messages.push({role:'assistant',text:'已收到拒绝。我不会继续这次读取。你可以调整范围后重新发送，也可以结束运行。'});render();return;}
 s.messages.push({role:'system',text:i.type==='form'?'已发送你的选择：'+accepted:'已发送本次允许。等待 Agent 继续。'});s.turn='running';render();
 timers.set(s.id,setTimeout(()=>finishMock(s),2600));
}
function referenceSidebar() {
 const hidden=window.innerWidth<800?!state.mobileNav:!!state.sidebarCollapsed;
 const folded=state.foldedProjects||[];
 return `<aside class="sidebar reference-sidebar" ${hidden?'inert aria-hidden="true"':''}>
 <div class="reference-brand-row"><a class="brand" href="?variant=D&theme=${escape(state.theme)}" aria-label="Aork 原型首页"><span class="brand-mark">a</span><span>aork</span></a>${iconButton('panel','收起导航','toggle-sidebar')}</div>
 <div class="reference-sidebar-actions">${button(icon('plus')+' 新会话','new-session','secondary','id="new-session-nav"')}${iconButton('search','搜索会话','search-sessions')}</div>
 <nav aria-label="主导航"><button class="nav-item ${state.view==='pending'?'active':''}" data-action="view" data-view="pending" aria-label="待处理">${icon('inbox')}<span class="nav-label">待处理</span>${pending().length?`<span class="count">${pending().length}</span>`:''}</button><button class="nav-item ${state.view==='projects'?'active':''}" data-action="view" data-view="projects">${icon('folder')}<span>所有项目</span></button></nav>
 <div class="reference-projects"><div class="section-label"><span>项目与会话</span>${iconButton('plus','新建项目','new-project')}</div>${state.projects.map(p=>`<section class="reference-project"><div class="reference-project-heading"><button class="tree-toggle" data-action="toggle-project" data-id="${p.id}" aria-expanded="${!folded.includes(p.id)}">${icon(folded.includes(p.id)?'chevron':'down')}<span>${escape(p.name)}</span><small>${state.sessions.filter(s=>s.project===p.id).length}</small></button>${iconButton('plus','在'+p.name+'新建会话','new-project-session',`data-project="${p.id}"`)}</div><div class="reference-project-content" ${folded.includes(p.id)?'hidden':''}>${state.workspaces.filter(w=>w.project===p.id).map(w=>`<div class="reference-workspace-row"><button class="workspace-label" data-action="workspace-context" data-id="${w.id}" title="${escape(w.path)}">${icon('folder')}<span>${escape(w.name)}</span></button></div><div class="reference-session-list">${state.sessions.filter(s=>s.workspace===w.id).map(s=>`<button class="session-item tree-session ${state.session===s.id && state.view==='work'?'active':''}" data-action="session" data-id="${s.id}" title="${escape(s.agent+' · '+statusLabel(s))}"><span class="session-title">${escape(s.title)}</span><span class="tree-session-state">${s.unread?'<span class="unread-dot" aria-label="未读"></span>':`<span class="status-dot ${s.turn}" aria-label="${escape(statusLabel(s))}"></span>`}</span></button>`).join('') || '<div class="tree-empty">暂无会话</div>'}</div>`).join('')}</div></section>`).join('')}</div>
 <div class="sidebar-bottom"><button class="nav-item ${state.view==='settings'?'active':''}" data-action="view" data-view="settings">${icon('settings')}<span>设置</span></button></div></aside>`;
}
function referenceTopbar() {
 const s=current(), names={pending:'待处理',projects:'所有项目',settings:'设置'};
 return `<header class="topbar reference-topbar">${iconButton('menu','展开或收起导航','toggle-sidebar')}<div class="reference-context"><div class="context-trail"><span>${escape(project(s.project)?.name)}</span>${icon('chevron')}<span>${escape(workspace(s.workspace)?.name)}</span></div><div class="reference-title-row"><h1 class="reference-session-title">${escape(state.view==='work'?s.title:names[state.view]||'工作台')}</h1>${state.view==='work'?iconButton('down','切换会话','choose-session'):''}</div></div><div class="topbar-actions"><span class="prototype-tag">原型 · 示例</span><a class="button ghost small" href="references.html" target="_blank" rel="noopener">设计参考</a>${state.view==='work'?iconButton('panel','文件与 Git 改动面板','toggle-inspector')+iconButton('dots','会话操作','session-menu'):''}</div></header>`;
}
function referenceViewbar(s) {
 return `<header class="conversation-header reference-viewbar"><div class="reference-view-tabs"><span class="reference-active-tab">${icon('chat')}对话</span></div><div class="reference-run-status"><span class="status-dot ${s.turn}"></span>${escape(statusLabel(s))}</div></header>`;
}
function referenceComposerControls(s, active) {
 return `<div class="reference-composer-left">${iconButton('attach','添加文件','attach')}</div><div class="reference-composer-right">${button(s.agent+' '+icon('down'),'handoff','ghost small','title="更换 Agent 将创建关联会话"')}${button(escape(s.model)+' '+icon('down'),'model','ghost small')}${active?iconButton('stop','停止当前轮次','cancel-turn'):''}<button type="submit" class="send-button" aria-label="${active?'加入队列':'发送消息'}">${icon('arrow')}</button></div>`;
}
function renderTimeline(s) {
 if(state.variant!=='D' || !state.pluginConfig.sessions.showActivity)return s.messages.map(m=>message(m,s)).join('');
 let html='';
 for(let n=0;n<s.messages.length;n++) {
  if(s.messages[n].role!=='tool'){html+=message(s.messages[n],s);continue;}
  const start=n,group=[s.messages[n]];
  while(s.messages[n+1]?.role==='tool')group.push(s.messages[++n]);
  const key=s.id+'-'+start,open=state.activityOpen?.[key] ?? s.turn==='running';
  html+=`<details class="activity-group" data-activity-key="${key}" ${open?'open':''}><summary class="activity-summary" id="activity-${key}">${icon('chevron')}<span>${group.length} 项执行过程</span><span class="muted">${escape(group.at(-1).text)}</span></summary><div class="activity-details">${group.map(m=>message(m,s)).join('')}</div></details>`;
 }
 return html;
}
function sidebar() {
 if(state.variant==='D')return referenceSidebar();
 const total=pending().length;
 return `<aside class="sidebar" ${window.innerWidth<800 && !state.mobileNav?'inert aria-hidden="true"':''}><button type="button" class="nav-mobile-close icon-button" data-action="mobile-nav" aria-label="关闭导航">${icon('close')}</button><a class="brand" href="?variant=${state.variant}" aria-label="Aork 原型首页"><span class="brand-mark">a</span><span class="nav-label">aork<span class="brand-caption">你的 AI 工作环境</span></span></a>
 <button id="new-session-nav" class="button primary new-session" aria-label="新建会话" data-action="new-session">${icon('plus')}<span class="nav-label">新建会话</span></button>
 <nav aria-label="主导航"><button class="nav-item ${state.view==='pending'?'active':''}" data-action="view" data-view="pending" title="待处理" aria-label="待处理">${icon('inbox')}<span class="nav-label">待处理</span>${total?`<span class="count">${total}</span>`:''}</button>
 <button class="nav-item ${state.view==='projects'?'active':''}" data-action="view" data-view="projects" title="项目" aria-label="项目">${icon('folder')}<span class="nav-label">项目</span></button></nav>
 <div class="sidebar-section"><div class="section-label"><span class="nav-label">项目</span>${iconButton('plus','新建项目','new-project')}</div>${state.projects.map(p=>`<button class="project-item ${p.id===state.project && state.view==='work'?'active':''}" data-action="project" data-id="${p.id}" title="${escape(p.name)}"><span class="project-icon ${p.color}">${escape(p.name.slice(0,1))}</span><span class="nav-label">${escape(p.name)}</span></button>`).join('')}</div>
 <div class="sidebar-bottom"><button class="nav-item ${state.view==='settings'?'active':''}" data-action="view" data-view="settings" title="设置" aria-label="设置">${icon('settings')}<span class="nav-label">设置</span></button></div></aside>`;
}
function topbar() {
 if(state.variant==='D')return referenceTopbar();
 const labels={work:project(state.project)?.name,pending:'待处理',projects:'项目',settings:'设置'};
 return `<header class="topbar"><div class="breadcrumb">${iconButton('menu','打开导航','mobile-nav').replace('class="icon-button"','class="icon-button mobile-menu"')}<span>Aork</span>${icon('chevron')}<strong>${escape(labels[state.view] || '工作台')}</strong></div><div class="topbar-actions"><span class="prototype-tag"><span class="status-dot"></span>交互原型 · 示例数据</span>${button('操作引导','guide','ghost small')}${iconButton('panel','文件与 Git 改动面板','toggle-inspector')}</div></header>`;
}
function sessionRail() {
 const list=state.sessions.filter(s=>s.project===state.project);
 return `<aside class="session-rail"><div class="rail-heading"><span>会话 <span class="muted">${list.length}</span></span>${iconButton('plus','新建会话','new-session')}</div><div class="section-label">最近</div>${list.map(sessionItem).join('')}<button class="link-button rail-new" data-action="new-session">${icon('plus')} 开始新的工作</button></aside>`;
}
function sessionItem(s) { return `<button class="session-item ${state.session===s.id?'active':''}" data-action="session" data-id="${s.id}"><span class="session-title">${escape(s.title)}${s.unread?'<span class="unread-dot" title="未读回复"></span>':''}</span><span class="session-meta"><span class="status-dot ${s.turn}"></span>${escape(statusLabel(s))}<span>· ${s.agent}</span></span></button>`; }
function inboxPanel() { return `<aside class="inbox-panel"><div class="inbox-heading"><span class="eyebrow">需要关注</span><h2>先处理，再继续</h2><p class="muted">${pending().length} 个有效请求 · ${state.sessions.filter(s=>s.unread).length} 个未读回复</p></div>${pending().map(i=>{const s=state.sessions.find(x=>x.id===i.session);return `<button class="inbox-card ${s.id===state.session?'active':''}" data-action="session" data-id="${s.id}"><span class="badge">${i.type==='permission'?'权限请求':'需要补充信息'}</span><h3>${escape(i.title)}</h3><p>${escape(s.title)}</p><span class="muted">${escape(project(s.project).name)} · ${s.agent}</span></button>`;}).join('') || '<div class="empty-state small">'+icon('check')+'<p>没有待处理请求</p></div>'}<div class="section-label">最近的会话</div>${state.sessions.map(sessionItem).join('')}</aside>`; }
function interactionCard(i) {
 const valid=i.status==='pending';
 if(!valid)return `<div class="tool-event interaction-result">${icon(i.status==='responded'?'check':'info')}<span>${escape(i.title)} · ${i.status==='responded'?'已发送响应':'请求已失效'}</span></div>`;
 return `<section class="interaction-card"><div class="interaction-title">${icon(i.type==='permission'?'shield':'chat')}<div><span class="eyebrow">${i.type==='permission'?'需要你的许可':'需要你的输入'}</span><h3>${escape(i.title)}</h3></div></div><p>${escape(i.description)}</p>${i.type==='permission'?`<div class="interaction-details">${icon('folder')}<span>${escape(workspace(current().workspace)?.path)}<br><span class="muted">仅限这次请求，不自动授权后续操作</span></span></div><div class="interaction-actions">${button('拒绝','deny','secondary',`data-id="${i.id}"`)}${button('允许本次读取','approve','primary',`data-id="${i.id}"`)}</div>`:`<form data-form="interaction" data-id="${i.id}"><label class="form-label" for="answer-${i.id}">选择一个方向</label><select id="answer-${i.id}" class="form-select" name="answer" data-interaction-draft="${i.id}">${['以项目与会话为中心','优先处理等待中的请求','先给出简短建议，再展开细节'].map(choice=>`<option ${i.draftAnswer===choice?'selected':''}>${choice}</option>`).join('')}</select><div class="interaction-actions"><button class="button primary" type="submit">发送选择 ${icon('arrow')}</button></div></form>`}</section>`;
}
function messageText(m) {const text=String(m.text || '');return state.variant==='D' && m.role==='assistant'?text.split(/\n{2,}/).map(p=>'<p>'+escape(p).replace(/\n/g,'<br>')+'</p>').join(''):escape(text).replace(/\n/g,'<br>');}
function message(m,s) {
 if(m.role==='tool' || m.role==='system')return `<div class="tool-event ${m.role}">${icon(m.role==='tool'?'check':'info')}<span>${escape(m.text)}</span></div>`;
 return `<article class="message ${m.role}" aria-label="${m.role==='user'?'你的消息':escape(s.agent)+' 的回复'}"><div class="message-avatar ${m.role==='assistant'?'agent-avatar':''}">${m.role==='user'?'Y':s.agent.slice(0,1)}</div><div class="message-body"><div class="message-meta"><strong>${m.role==='user'?'你':s.agent}</strong><span>${m.role==='user'?'工作台':'Agent'}</span></div><div class="message-text">${messageText(m)}</div>${m.attachments?.length?`<div class="attachment-chips">${m.attachments.map(a=>`<span class="chip">${icon('file')}${escape(a)}</span>`).join('')}</div>`:''}</div></article>`;
}
function conversation() {
 const s=current(), w=workspace(s.workspace);const active=['running','waiting','cancelling'].includes(s.turn);
 const intro=state.variant==='C'?`<div class="focus-session-picker">${button(icon('chat')+' '+escape(s.title)+' '+icon('down'),'choose-session','ghost')}</div>`:'';
 return `<main class="conversation" id="work-content" tabindex="-1">${intro}${state.variant==='D'?referenceViewbar(s):`<header class="conversation-header"><div class="heading-title"><span class="eyebrow">${escape(project(s.project).kind)}工作区</span><h1>${escape(s.title)} ${iconButton('down','切换会话','choose-session')}</h1><div class="session-subtitle"><span class="agent-pill">${s.agent.slice(0,1)} <strong>${s.agent}</strong></span><span>${escape(w?.name || '')}</span><span class="status-pill ${s.turn}"><span class="status-dot ${s.turn}"></span>${escape(statusLabel(s))}</span></div></div><div class="session-actions">${iconButton('dots','会话操作','session-menu')}${iconButton('panel','打开文件与 Git 改动','toggle-inspector')}</div></header>`}
 <div class="messages" id="messages"><div class="day-divider">今天 · ${s.agent} 在服务器工作区中工作</div>
 ${s.turn==='interrupted'||s.turn==='delivery_unknown'?`<div class="notice warning"><strong>${s.turn==='delivery_unknown'?'最后一条输入的交付结果不确定':'这次执行已中断'}</strong><p>已保存的内容仍在。恢复连接不会自动重发输入或继续队列。</p><div>${button('恢复会话','restore','secondary small')}${button('关联新会话','handoff','ghost small')}</div></div>`:''}
 ${renderTimeline(s)}
 ${state.interactions.filter(i=>i.session===s.id).slice(-2).map(interactionCard).join('')}
 ${s.turn==='running'?`<div class="thinking"><span class="thinking-dot"></span><span>${s.agent} 正在处理示例文件</span><span class="muted">模拟执行</span></div>`:''}
 ${s.turn==='cancelling'?'<div class="notice">正在停止本轮，请等待终止结果…</div>':''}
 ${s.run==='terminated' && s.turn!=='interrupted'?'<div class="notice"><span>运行已结束，工作区占用已释放。</span> '+button('继续此会话','restore','ghost small')+'</div>':''}
 </div><div class="composer-area">${s.queue.length?`<div class="queue-strip">${icon('clock')}<span>${s.queue.length} 条输入${s.paused?'已暂停':'排队中'}</span><span class="muted">${escape(s.queue[0].text.slice(0,24))}</span>${button('查看队列','queue','ghost small')}${s.paused?button('继续队列','resume-queue','ghost small',canDispatch(s)?'':'disabled'):''}</div>`:''}
 ${(state.attachments[s.id]||[]).length?`<div class="attachment-chips">${state.attachments[s.id].map((a,n)=>`<button class="chip" data-action="remove-attachment" data-index="${n}">${icon('file')}${escape(a)} ${icon('close')}</button>`).join('')}</div>`:''}
 <form class="composer" data-form="message"><textarea id="composer" class="composer-input" rows="${state.variant==='D'?1:3}" placeholder="${active?'补充下一步，输入会进入队列…':'描述你想完成的工作…'}" aria-label="消息输入">${escape(state.drafts[s.id]||'')}</textarea><div class="composer-footer">${state.variant==='D'?referenceComposerControls(s,active):`<div class="composer-tools">${iconButton('attach','添加文件','attach')}${button(escape(s.model)+' '+icon('down'),'model','ghost small')}<span class="muted composer-tools-label">${state.plugins.filter(p=>p.enabled).length} 项能力可用</span></div><div class="composer-tools">${active?iconButton('stop','停止当前轮次','cancel-turn'):''}<button type="submit" class="send-button" aria-label="${active?'加入队列':'发送消息'}" title="${active?'加入队列':'发送消息'}">${icon('arrow')}</button></div>`}</div></form>
 <div class="composer-hint reference-environment"><span>${state.variant==='D'?escape(w?.name)+' · ':''}${alive(s)?'当前运行占用':'当前运行未占用'} · ${escape(s.agent)}</span>${alive(s)?'<button class="link-button" data-action="end-run">结束运行</button>':'<span>Enter 发送 · Shift + Enter 换行</span>'}</div></div></main>`;
}
function fileData(workspaceId=current().workspace) { return workspace(workspaceId)?.files || []; }
function panelState(workspaceId=current().workspace) {
 return state.workspaceViews[workspaceId] ||= {tab:'files',query:'',searchCollapsed:[],selected:workspaceId==='w2' && window.innerWidth>=800?'src/components/layout/WorkspacePanel.tsx':null,expanded:workspaceId==='w2'?['src','src/components','src/components/layout']:[],treeFocus:null,source:state.pluginConfig.git.defaultSource,openChanges:{},gitStatus:null};
}
function sourceChanges(w=workspace(current().workspace),source=panelState().source) { return w?.git?.sources?.[source] || []; }
function selectedFile() {
 const w=workspace(current().workspace),selected=panelState().selected;
 const file=fileData().find(f=>f.path===selected);if(file)return file;
 const change=Object.values(w?.git?.sources || {}).flat().find(c=>c.path===selected && c.status==='D');
 return change?{...fixtureFile(change.path,change.before),deleted:true}:null;
}
function fileTree(files,prefix='',depth=0) {
 const view=panelState(),query=view.query.trim().toLowerCase(),entries=new Map();
 for(const file of files) {
  if(!state.pluginConfig.files.showHidden && file.path.split('/').some(part=>part.startsWith('.')))continue;
  if(query && !file.path.toLowerCase().includes(query))continue;
  if(!file.path.startsWith(prefix))continue;
  const rest=file.path.slice(prefix.length),name=rest.split('/')[0],path=prefix+name;
  if(!entries.has(name))entries.set(name,{name,path,folder:rest.includes('/')});
 }
 const sorted=[...entries.values()].sort((a,b)=>Number(b.folder)-Number(a.folder) || a.name.localeCompare(b.name));
 return sorted.map(entry=>{
  const open=query?!view.searchCollapsed.includes(entry.path):view.expanded.includes(entry.path),selected=view.selected===entry.path;
  const focusPath=view.treeFocus || view.selected || sorted[0]?.path;
  return `<li role="none"><button type="button" class="${entry.folder?'tree-folder':'tree-file'} ${selected?'selected':''}" role="treeitem" aria-level="${depth+1}" ${entry.folder?`aria-expanded="${open}"`:`aria-selected="${selected}"`} data-action="${entry.folder?'toggle-folder':'file'}" data-path="${escape(entry.path)}" data-parent="${escape(prefix.slice(0,-1))}" tabindex="${focusPath===entry.path?0:-1}" style="--tree-depth:${depth}" title="${escape(entry.path)}">${entry.folder?icon(open?'down':'chevron'):''}${icon(entry.folder?'folder':'file')}<span>${escape(entry.name)}</span></button>${entry.folder && open?`<ul role="group">${fileTree(files,entry.path+'/',depth+1)}</ul>`:''}</li>`;
 }).join('');
}
function filePreview(file) {
 return `<section class="file-preview-pane" aria-label="文件预览"><header class="file-preview-header"><div class="file-preview-title">${button(icon('back')+' 文件列表','close-preview','ghost small')}${button(icon('attach')+' 加入输入','attach-selected','secondary small',file.deleted?'disabled title="文件已删除，请查看差异"':'')}</div><strong title="${escape(file.path)}">${escape(file.name)}</strong><span class="file-preview-path mono">${escape(file.path)}</span><div class="file-preview-meta"><span>${escape(file.language)}</span><span>${file.content.split('\n').length} 行</span>${file.deleted?'<span class="badge">删除前的示例内容</span>':'<span class="muted">只读示例</span>'}</div></header><div id="file-code-preview" class="code-view" data-scroll-key="${escape(current().workspace+':'+file.path)}" tabindex="0" aria-label="${escape(file.name)} 内容">${file.content.split('\n').map((line,n)=>`<div class="code-line"><span class="line-number" aria-hidden="true">${n+1}</span><code class="line-content">${escape(line) || ' '}</code></div>`).join('')}</div></section>`;
}
function filesPanel() {
 const w=workspace(current().workspace),view=panelState(),file=selectedFile(),files=fileData(),tree=fileTree(files);
 return `<div class="file-browser-toolbar"><label class="file-search-label" for="workspace-file-search">${icon('search')}<input id="workspace-file-search" class="file-search" type="search" placeholder="搜索文件名或路径…" aria-label="搜索工作区文件" value="${escape(view.query)}"></label>${view.query?iconButton('close','清除文件搜索','clear-file-search'):''}${iconButton('folder','折叠全部目录','collapse-folders')}</div><div class="file-browser-layout ${file?'has-preview':''}"><section class="file-tree-pane" aria-label="文件列表"><div class="section-label"><span>${escape(w?.name)}</span><span>${files.filter(f=>state.pluginConfig.files.showHidden || !f.path.split('/').some(p=>p.startsWith('.'))).length} 个文件</span></div>${tree?`<ul class="file-tree" role="tree" aria-label="${escape(w?.name)} 文件">${tree}</ul>`:`<div class="empty-state">${icon('folder')}<h3>${view.query?'没有匹配的文件':'工作区还没有文件'}</h3><p>${view.query?'试试其它文件名或路径。':'新工作区不会继承其他项目的示例文件。'}</p>${view.query?button('清除搜索','clear-file-search','secondary small'):''}</div>`}</section>${file?filePreview(file):'<section class="file-preview-pane preview-placeholder"><div class="empty-state">'+icon('file')+'<p>选择文件查看内容</p></div></section>'}</div>`;
}
function gitPanel() {
 const w=workspace(current().workspace),view=panelState(),plugin=state.plugins.find(p=>p.id==='git');
 if(!plugin.enabled)return `<div class="empty-state">${icon('plug')}<h3>Git 插件已停用</h3><p>可在设置中启用，再查看示例改动。</p>${button('打开插件设置','open-plugin-settings','secondary')}</div>`;
 if(!w?.git)return `<div class="empty-state">${icon('folder')}<h3>当前工作区不是 Git 仓库</h3><p>可以在文件页签预览已有文件；新工作区也不会自动生成 Git 改动。</p>${button('查看文件','tab','secondary','data-tab="files"')}</div>`;
 const status=view.gitStatus || w.git.status,changes=status==='clean'?[]:sourceChanges(w),added=changes.reduce((n,c)=>n+c.added,0),removed=changes.reduce((n,c)=>n+c.removed,0);
 if(!(view.source in view.openChanges))view.openChanges[view.source]=changes[0]?.path || null;
 const toolbar=`<div class="git-toolbar"><div class="git-branch">${icon('link')}<strong title="${escape(w.git.branch)}">${escape(w.git.branch)}</strong><span class="badge">示例</span></div><label class="git-source-label" for="git-source">比较来源</label><select id="git-source" class="git-source-select form-select" aria-label="Git 改动来源">${Object.entries(gitSources).map(([value,label])=>`<option value="${value}" ${view.source===value?'selected':''}>${label}${value==='branch'?' · '+escape(w.git.base):''}</option>`).join('')}</select></div>`;
 if(status==='error')return toolbar+`<div class="empty-state">${icon('info')}<h3>无法读取 Git 改动</h3><p>这是模拟读取失败状态，文件浏览仍可使用。</p>${button('重新载入示例','retry-git','secondary')}</div>`;
 const notes={unstaged:'工作区相对暂存区的改动',staged:'暂存区相对 HEAD 的改动',branch:'当前工作相对 main 的累计改动',previous:'最近一轮 Agent 执行前后的改动'};
 return toolbar+`<div class="git-summary"><span>${changes.length} 个改动文件</span><span class="git-stat added">+${added}</span><span class="git-stat removed">−${removed}</span></div><p class="git-source-note">${notes[view.source]}</p><div class="git-changes">${changes.map(change=>{
  const open=view.openChanges[view.source]===change.path;
  return `<section class="git-change"><div class="git-change-header"><button class="git-change-toggle" data-action="toggle-diff" data-path="${escape(change.path)}" aria-expanded="${open}" title="${escape(change.path)}">${icon(open?'down':'chevron')}<span class="git-status status-${change.status.toLowerCase()}" aria-label="${({M:'修改',A:'新增',D:'删除'})[change.status]}">${change.status}</span><span class="git-file-name"><span class="git-file-basename">${escape(change.path.split('/').at(-1))}</span><span class="git-file-directory">${escape(change.path.split('/').slice(0,-1).join('/'))}</span></span><span class="git-file-meta"><span class="git-stat added">+${change.added}</span><span class="git-stat removed">−${change.removed}</span></span></button>${iconButton('file','在文件页签查看 '+change.path,'git-file',`data-path="${escape(change.path)}"`)}</div>${open?`<div id="git-diff-view" class="diff-table" data-scroll-key="${escape(current().workspace+':'+view.source+':'+change.path)}" tabindex="0" aria-label="${escape(change.path)} 统一差异"><div class="diff-hunk">${escape(change.hunk)}</div>${change.rows.map(row=>`<div class="diff-line diff-${row.type}"><span class="visually-hidden">${row.type==='added'?'新增':row.type==='removed'?'删除':'未变化'}，旧行${row.old || '无'}，新行${row.new || '无'}。</span><span class="diff-old-number" aria-hidden="true">${row.old}</span><span class="diff-new-number" aria-hidden="true">${row.new}</span><code class="diff-content"><span class="diff-marker" aria-hidden="true">${row.type==='added'?'+':row.type==='removed'?'−':' '}</span>${escape(row.text) || ' '}</code></div>`).join('')}</div>`:''}</section>`;
 }).join('') || `<div class="empty-state">${icon('check')}<h3>${status==='clean'?'工作区没有改动':'此来源没有改动'}</h3><p>${status==='clean'?'当前演示为干净工作区。':'切换比较来源，查看其他示例差异。'}</p></div>`}</div>`;
}
function inspector() {
 const view=panelState();
 return `<aside class="inspector open workspace-panel ${state.panelWide?'wide':''}" aria-label="文件与 Git 改动"><div class="panel-tabs tabs" role="tablist" aria-label="工作区面板"><button id="panel-tab-files" class="tab ${view.tab==='files'?'active':''}" role="tab" aria-selected="${view.tab==='files'}" aria-controls="workspace-panel-content" tabindex="${view.tab==='files'?0:-1}" data-action="tab" data-tab="files">${icon('folder')}文件</button><button id="panel-tab-git" class="tab ${view.tab==='git'?'active':''}" role="tab" aria-selected="${view.tab==='git'}" aria-controls="workspace-panel-content" tabindex="${view.tab==='git'?0:-1}" data-action="tab" data-tab="git">${icon('link')}Git 改动</button><span class="panel-actions">${iconButton('panel',state.panelWide?'还原面板宽度':'加宽面板','resize-panel',`id="workspace-resize-panel" aria-pressed="${state.panelWide}"`)}${iconButton('close','关闭文件与 Git 改动面板','toggle-inspector')}</span></div><div id="workspace-panel-content" class="workspace-panel-content inspector-content" role="tabpanel" aria-labelledby="panel-tab-${view.tab}">${view.tab==='files'?filesPanel():gitPanel()}</div><div class="inspector-footer">${icon('folder')}<span class="mono" title="${escape(workspace(current().workspace)?.path)}">${escape(workspace(current().workspace)?.path)}</span><span>内存示例</span></div></aside>`;
}
function projectsPage() { return `<main id="work-content" tabindex="-1" class="content-page"><div class="page-heading"><div><span class="eyebrow">把工作组织起来</span><h1>项目</h1><p class="page-lead">项目可以是代码，也可以是一组长期关心的问题。</p></div>${button(icon('plus')+' 新建项目','new-project','primary')}</div><div class="project-grid">${state.projects.map(p=>`<article class="project-card"><div class="project-card-header"><span class="project-icon ${p.color}">${escape(p.name.slice(0,1))}</span><span class="badge">${p.kind}</span></div><h2>${escape(p.name)}</h2><p class="muted">${state.sessions.filter(s=>s.project===p.id).length} 个会话 · ${state.workspaces.filter(w=>w.project===p.id).length} 个工作区</p>${state.workspaces.filter(w=>w.project===p.id).map(w=>`<div class="workspace-row">${icon('folder')}<span>${escape(w.name)}<small class="mono">${escape(w.path)}</small></span></div>`).join('')}<div class="form-actions">${button('打开项目','project','secondary small',`data-id="${p.id}"`)}${button('新建工作区','new-workspace','ghost small',`data-project="${p.id}"`)}</div></article>`).join('')}</div></main>`; }
function pendingPage() { return `<main id="work-content" tabindex="-1" class="content-page"><div class="page-heading"><div><span class="eyebrow">保持工作向前</span><h1>待处理 <span class="muted">${pending().length}</span></h1><p class="page-lead">这里只显示仍可响应的请求。普通回复放在未读中。</p></div></div><div class="pending-list">${pending().map(i=>{const s=state.sessions.find(x=>x.id===i.session);return `<article class="pending-row"><span class="plugin-icon">${icon(i.type==='permission'?'shield':'chat')}</span><div><span class="eyebrow">${escape(project(s.project).name)} · ${s.agent}</span><h2>${escape(i.title)}</h2><p class="muted">${escape(s.title)} · ${i.type==='permission'?'等待许可':'需要补充信息'}</p></div>${button('查看并回应 '+icon('chevron'),'session','secondary',`data-id="${s.id}"`)}</article>`;}).join('') || '<div class="empty-state">'+icon('check')+'<h2>现在没有需要回应的请求</h2><p>你可以继续已有会话，或开始新的工作。</p></div>'}</div><h2 class="subheading">未读回复 <span class="muted">${state.sessions.filter(s=>s.unread).length}</span></h2>${state.sessions.filter(s=>s.unread).map(s=>`<article class="pending-row"><span class="unread-dot"></span><div><h3>${escape(s.title)}</h3><p class="muted">${s.agent} 已完成回复 · 打开后标记为已读</p></div>${button('阅读回复','session','ghost',`data-id="${s.id}"`)}</article>`).join('') || '<p class="muted">没有未读回复</p>'}</main>`; }
function activePluginRuns(plugin) { return state.sessions.filter(s=>alive(s) && (plugin.id!=='git' || workspace(s.workspace)?.git)); }
function themeChoice(){return `<div class="appearance-control"><label for="appearance-theme">主题</label><select class="form-select" id="appearance-theme" name="theme">${[['system','跟随系统'],['light','浅色'],['dark','深色']].map(([value,label])=>`<option value="${value}" ${state.theme===value?'selected':''}>${label}</option>`).join('')}</select></div>`;}
function settingsPage() {
 const agents=state.settingsTab==='agents';
 const agentSettings=`<div class="settings-grid">${['Claude','Codex'].map(agent=>`<article class="settings-card"><span class="agent-avatar">${agent[0]}</span><h2>${agent}</h2><p class="muted">${agent==='Claude'?'研究与文档':'编程与文件处理'} · 示例配置</p><div class="workspace-row">${icon('settings')}${escape(state.profiles[agent])}</div><div class="workspace-row">${icon('shield')}凭据：服务器引用 · 示例</div><div class="workspace-row">${icon('folder')}状态目录：独立保存</div>${button('查看配置','profile','secondary',`data-agent="${agent}"`)}</article>`).join('')}</div><div class="notice">所有连接状态为内存示例，不会接入真实 Agent 或读取凭据。已有会话保留创建时的配置。</div>`;
 const pluginSettings=`<div class="plugin-list">${state.plugins.map(p=>`<article class="plugin-row"><span class="plugin-icon">${icon(p.icon)}</span><div class="plugin-description"><h2>${p.name}${p.required?'<span class="badge">基础能力</span>':''}</h2><p>${p.description}</p><small class="muted">Aork · v0.1 · ${p.enabled?'已启用':'已停用'}</small></div><div class="plugin-actions">${button('配置','plugin-config','ghost small',`data-id="${p.id}"`)}<button class="toggle ${p.enabled?'on':''}" role="switch" aria-checked="${p.enabled}" aria-label="${p.enabled?'停用':'启用'}${p.name}" data-action="toggle-plugin" data-id="${p.id}" ${p.required?'disabled title="当前工作台需要此基础能力"':''}><span></span></button></div></article>`).join('')}</div><div class="notice">插件配置在此集中管理。正在使用的能力停用前，需要结束受影响的运行。</div>`;
 return `<main id="work-content" tabindex="-1" class="content-page"><div class="page-heading"><div><h1>设置</h1><p class="page-lead">管理 Agent 接入与工作台插件。</p></div>${themeChoice()}</div><div class="settings-tabs tabs" role="tablist" aria-label="设置分类"><button id="settings-tab-agents" class="tab ${agents?'active':''}" role="tab" aria-selected="${agents}" aria-controls="settings-section" tabindex="${agents?0:-1}" data-action="settings-tab" data-tab="agents">Agent</button><button id="settings-tab-plugins" class="tab ${!agents?'active':''}" role="tab" aria-selected="${!agents}" aria-controls="settings-section" tabindex="${!agents?0:-1}" data-action="settings-tab" data-tab="plugins">插件</button></div><section id="settings-section" class="settings-section" role="tabpanel" aria-labelledby="settings-tab-${state.settingsTab}">${agents?agentSettings:pluginSettings}</section></main>`;
}
function toolbar() { return `<aside class="prototype-toolbar" aria-label="原型评审工具"><span class="prototype-label">原型</span><button class="variant-button" data-action="scenarios">模拟状态</button><a class="variant-button" href="references.html" target="_blank" rel="noopener">参考</a>${iconButton('restart','重置原型','reset')}</aside>`; }
function inspectorOverlays() { return state.view==='work' && state.inspector && (state.variant==='D'?window.innerWidth<1150:state.variant==='A'?window.innerWidth<1100:true); }
function focusTarget(selector) { if(!selector)return false;const target=[...document.querySelectorAll(selector)].find(el=>!el.disabled && !el.closest('[inert]') && el.getClientRects().length);if(!target)return false;target.focus({preventScroll:true});return true; }
function trapFocus(selector,event) { const controls=[...document.querySelectorAll(selector+' button,'+selector+' input,'+selector+' select,'+selector+' textarea,'+selector+' a[href],'+selector+' summary,'+selector+' [tabindex]:not([tabindex="-1"])')].filter(el=>el.tabIndex>=0 && !el.disabled && !el.closest('[inert]') && el.getClientRects().length);const first=controls[0],last=controls.at(-1);if(event.shiftKey && document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first?.focus();} }
let panelTrigger;
function setInspector(open,tabName) { if(open && (!state.inspector || state.view!=='work'))panelTrigger=focusSelector(document.activeElement);state.inspector=open;if(tabName)panelState().tab=tabName;if(open){state.mobileNav=false;state.view='work';}render();if(open && inspectorOverlays())focusTarget('.inspector [data-action="toggle-inspector"]');else if(!open && !focusTarget(panelTrigger))focusTarget('#composer'); }
function toggleNavigation() { if(window.innerWidth<800){state.mobileNav=!state.mobileNav;if(state.mobileNav)state.inspector=false;}else state.sidebarCollapsed=!state.sidebarCollapsed;render();if(window.innerWidth<800 && state.mobileNav || window.innerWidth>=800 && !state.sidebarCollapsed)focusTarget('.sidebar button');else focusTarget('.topbar [data-action="toggle-sidebar"],.topbar [data-action="mobile-nav"]'); }

function resizeComposer() {const el=$('#composer');if(!el || state.variant!=='D')return;el.style.height='36px';el.style.height=Math.min(180,Math.max(36,el.scrollHeight))+'px';}
function render() {
 if(composing)return;
 const theme=resolvedTheme();document.body.dataset.theme=theme;document.documentElement.style.colorScheme=theme;document.querySelector('meta[name="theme-color"]')?.setAttribute('content',theme==='dark'?'#181818':'#ffffff');
 document.body.classList.toggle('dsh-reference',state.variant==='D');
 const scrollPositions=new Map([...document.querySelectorAll('[data-scroll-key]')].map(el=>[el.dataset.scrollKey,{top:el.scrollTop,left:el.scrollLeft}]));
 const active=document.activeElement; const focus=focusSelector(active); const selection=typeof active?.selectionStart==='number'?[active.selectionStart,active.selectionEnd]:null;
 const oldMessages=$('#messages'),scroll=oldMessages?.scrollTop;const atBottom=!oldMessages || oldMessages.scrollHeight-oldMessages.clientHeight-oldMessages.scrollTop<100;
 let page=''; if(state.view==='work'){page=(state.variant==='A'?sessionRail():state.variant==='B'?inboxPanel():'')+conversation()+(state.inspector?inspector():'');}else page=({projects:projectsPage,pending:pendingPage,settings:settingsPage}[state.view]||projectsPage)();
 $('#app').innerHTML=`<div class="app-shell variant-${state.variant.toLowerCase()} ${state.mobileNav?'nav-open':''} ${state.variant==='D' && state.sidebarCollapsed?'sidebar-collapsed':''} ${state.inspector && state.view==='work'?'has-inspector inspector-open':''} ${state.inspector && state.panelWide?'inspector-wide':''}">${sidebar()}<section class="workspace">${topbar()}<div class="work-area">${page}</div></section></div>`+toolbar();
 const treeItems=[...document.querySelectorAll('.file-tree [role=treeitem]')],activeTreeItem=treeItems.find(el=>el.tabIndex===0) || treeItems[0];for(const item of treeItems)item.tabIndex=item===activeTreeItem?0:-1;
 for(const el of document.querySelectorAll('[data-scroll-key]')){const pos=scrollPositions.get(el.dataset.scrollKey);if(pos){el.scrollTop=pos.top;el.scrollLeft=pos.left;}}
 renderModal();$('#app').inert=!!state.modal;
 const overlay=inspectorOverlays(),navDrawer=window.innerWidth<800 && state.mobileNav;
 renderedViewport={compact:window.innerWidth<800,overlay};
 if(overlay){for(const el of document.querySelectorAll('.conversation,.session-rail,.inbox-panel,.topbar,.sidebar,.prototype-toolbar'))el.inert=true;const panel=$('.inspector');panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.setAttribute('aria-label','文件与 Git 改动');}
 else if(navDrawer){$('.workspace').inert=true;$('.prototype-toolbar').inert=true;}

 if(focus){const el=$(focus);if(el && !el.closest('[inert]') && el.getClientRects().length){el.focus({preventScroll:true});if(selection && typeof el.setSelectionRange==='function'){try{el.setSelectionRange(...selection);}catch{ /* select controls do not expose text selections */ }}}else if(state.modal)focusTarget('#overlays button');else if(overlay)focusTarget('.inspector button');else if(navDrawer)focusTarget('.sidebar button');else focusTarget('.topbar [data-action="toggle-sidebar"],.topbar [data-action="mobile-nav"]');}
 resizeComposer();
 const messages=$('#messages');if(messages)messages.scrollTop=atBottom?messages.scrollHeight:scroll;
}
function openModal(type,extra={}) {lastTrigger=focusSelector(document.activeElement);state.modal={type,...extra};render();requestAnimationFrame(()=>$('#overlays input, #overlays select, #overlays button')?.focus());}
function closeModal() {state.modal=null;render();if(!focusTarget(lastTrigger))focusTarget(inspectorOverlays()?'.inspector button':'#new-session-nav,.topbar button');}
function inputField(label,name,value='',placeholder='') {return `<div class="field"><label class="form-label" for="modal-${name}">${escape(label)}</label><input class="form-input" id="modal-${name}" name="${name}" autocomplete="off" data-modal-field="${name}" value="${escape(value)}" placeholder="${escape(placeholder)}" required></div>`;}
function renderModal() {
 const m=state.modal;if(!m){$('#overlays').innerHTML='';return;}
 let title='',body='',footer='',wide=false;
 if(m.type==='new-session' || m.type==='handoff'){
  title=m.type==='handoff'?'关联新的会话':'开始新的会话';m.draft ||= {title:m.type==='handoff'?current().title+' · 继续':'',project:state.project,workspace:'new',agent:m.type==='handoff'?(current().agent==='Claude'?'Codex':'Claude'):'Claude',carry:true};
  const d=m.draft;body=`<form id="new-session-form" data-form="new-session">${m.type==='handoff'?'<div class="notice">原会话保持不变。新 Agent 接收你选择的上下文，不继承原生会话 ID。</div>':''}${inputField('会话名称','title',d.title,'例如：整理本周的研究发现')}<div class="field"><label class="form-label" for="modal-project">项目</label><select class="form-select" id="modal-project" name="project" data-modal-field="project">${state.projects.map(p=>`<option value="${p.id}" ${p.id===d.project?'selected':''}>${escape(p.name)}</option>`).join('')}</select></div><div class="field"><label class="form-label" for="modal-workspace">工作区</label><select class="form-select" id="modal-workspace" name="workspace" data-modal-field="workspace"><option value="new">新建独立工作区（适合并行工作）</option>${state.workspaces.filter(w=>w.project===d.project).map(w=>`<option value="${w.id}" ${w.id===d.workspace?'selected':''}>${escape(w.name)}${state.sessions.some(s=>s.workspace===w.id && alive(s))?' · 被占用':''}</option>`).join('')}</select><p class="form-help">相同或重叠目录一次只能由一个运行写入。</p></div><label class="form-label">Agent</label><div class="radio-cards">${['Claude','Codex'].map(agent=>`<button type="button" class="choice-card ${d.agent===agent?'selected':''}" data-action="choose-agent" data-agent="${agent}"><span class="agent-avatar">${agent[0]}</span><strong>${agent}</strong><small>${agent==='Claude'?'研究与文档':'编程与文件处理'}</small></button>`).join('')}</div><div class="field"><label class="form-label">启用能力</label><div class="attachment-chips">${state.plugins.filter(p=>p.enabled).map(p=>`<span class="chip">${icon('check')}${p.name}</span>`).join('')}</div></div>${m.type==='handoff'?`<label class="checkbox-row"><input type="checkbox" name="carry" data-modal-field="carry" ${d.carry?'checked':''}> 携带原会话的示例摘要与已选文件引用</label><p class="form-help">已选引用：${escape((state.attachments[current().id]||[]).join('、')||'暂无；可先在文件面板加入输入')}</p>`:''}${m.error?`<div class="notice warning">${escape(m.error)}</div>`:''}</form>`;
  footer=button('取消','close-modal','secondary')+'<button type="submit" form="new-session-form" class="button primary">创建会话 '+icon('arrow')+'</button>';
 }else if(m.type==='new-project' || m.type==='new-workspace'){
  title=m.type==='new-project'?'新建项目':'添加工作区';m.draft||={name:'',path:''};body=`<form id="workspace-form" data-form="workspace">${inputField(m.type==='new-project'?'项目名称':'工作区名称','name',m.draft.name,'给这组工作一个名字')}${inputField('服务器目录（示例）','path',m.draft.path,'/srv/aork/workspaces/my-project')}<p class="form-help">这里只登记示例目录，不会创建或读写服务器文件。</p></form>`;footer=button('取消','close-modal','secondary')+'<button form="workspace-form" type="submit" class="button primary">创建</button>';
 }else if(m.type==='end-run'){
  title='结束运行并释放工作区？';body=`<p>${escape(current().agent)} 将停止本会话的执行，待处理请求失效，排队输入保留但暂停。</p><div class="notice">已有消息和文件不会删除。只有确认相关执行停止后，工作区才能交给其他会话。</div>`;footer=button('继续保留运行','close-modal','secondary')+button('结束运行','confirm-end','danger');
 }else if(m.type==='session-menu'){
  title='会话操作';body=`<div class="scenario-grid">${button(icon('restart')+' 恢复会话','restore','secondary')}${button(icon('chat')+' 关联新会话','handoff','secondary')}${button(icon('exit')+' 结束运行','end-run','secondary')}</div><p class="form-help">停止本轮只取消当前输入；结束运行才释放工作区。</p>`;
 }else if(m.type==='queue'){
  title='尚未执行的输入';body=current().queue.map((q,n)=>`<div class="pending-row"><div><strong>${n+1}. ${escape(q.text)}</strong><p class="muted">${escape(q.attachments.join('、')||'无附件')}</p></div>${button('移除','remove-queued','ghost small',`data-index="${n}"`)}</div>`).join('') || '<div class="empty-state"><p>没有尚未执行的输入</p></div>';
 }else if(m.type==='required-plugin'){
  title='当前工作台需要这项基础能力';body='<p>文件与会话是当前工作台的基础能力，需要保持启用。</p><div class="notice">这次操作不会停止运行，也不会删除已有记录。</div>';footer=button('保留启用','close-modal','primary');
 }else if(m.type==='choose-session'){
  title='切换会话';m.draft ||= {query:''};body='<label class="form-label" for="session-search">搜索会话</label><input class="form-input" id="session-search" name="query" autocomplete="off" data-modal-field="query" value="'+escape(m.draft.query)+'" placeholder="按标题搜索…">'+(state.sessions.filter(s=>s.title.toLowerCase().includes(m.draft.query.toLowerCase())).map(sessionItem).join('') || '<div class="empty-state"><p>没有匹配的会话</p></div>');
 }else if(m.type==='attach'){
  title='添加文件';m.draft ||= {query:''};const files=fileData().filter(f=>(state.pluginConfig.files.showHidden || !f.path.split('/').some(p=>p.startsWith('.'))) && f.path.toLowerCase().includes(m.draft.query.toLowerCase()));
  body=`<label class="form-label" for="attachment-search">当前工作区文件</label><input id="attachment-search" class="form-input" type="search" data-modal-field="query" value="${escape(m.draft.query)}" placeholder="搜索文件名或路径…">${files.map(file=>`<button class="file-row" data-action="attach-file" data-path="${escape(file.path)}">${icon('file')}<span><strong>${escape(file.name)}</strong><small>${escape(file.path)} · ${file.language}</small></span>${icon('plus')}</button>`).join('') || '<div class="empty-state"><p>没有可添加的文件</p><span class="muted">只列出当前工作区已有的示例文件。</span></div>'}`;
 }else if(m.type==='plugin-config'){
  const plugin=state.plugins.find(p=>p.id===m.id);title=plugin.name+'配置';m.draft ||= {...state.pluginConfig[m.id]};
  if(m.id==='files')body=`<label class="checkbox-row"><input id="show-hidden-files" type="checkbox" data-modal-field="showHidden" ${m.draft.showHidden?'checked':''}> 显示隐藏文件</label><p class="form-help">应用到文件树和“添加文件”列表。当前示例包含 .gitignore。</p>`;
  else if(m.id==='sessions')body=`<label class="checkbox-row"><input id="show-activity-groups" type="checkbox" data-modal-field="showActivity" ${m.draft.showActivity?'checked':''}> 将连续执行过程折叠成组</label><p class="form-help">关闭后逐条显示示例执行记录，消息与运行状态仍保留。</p>`;
  else body=`<label class="form-label" for="plugin-default-source">默认比较来源</label><select id="plugin-default-source" class="form-select" data-modal-field="defaultSource">${Object.entries(gitSources).map(([value,label])=>`<option value="${value}" ${m.draft.defaultSource===value?'selected':''}>${label}</option>`).join('')}</select><p class="form-help">保存后应用到已打开工作区；之后打开的工作区也使用此来源。</p>`;
  footer=button('取消','close-modal','secondary')+button('保存配置','save-plugin-config','primary');
 }else if(m.type==='profile' || m.type==='model'){
  title=m.type==='model'?'会话配置':m.agent+' Profile';m.draft ||= {model:m.type==='model'?current().model:state.profiles[m.agent]};body=`<p class="page-lead">${m.agent || current().agent} · 示例能力</p><label class="form-label" for="model-choice">模型 / 模式</label><select id="model-choice" class="form-select" data-modal-field="model">${['Sonnet · 示例','默认配置 · 示例','快速响应 · 示例','深入分析 · 示例'].map(choice=>`<option ${m.draft.model===choice?'selected':''}>${choice}</option>`).join('')}</select><div class="notice">真实选项将来自 Agent 的协商能力。原型不会读取、保存或提交凭据。</div>`;footer=button('完成','save-model','primary');
 }else if(m.type==='plugin-blocked'){
  const p=state.plugins.find(p=>p.id===m.id);title='这项能力仍在使用中';body=`<p>“${escape(p.name)}”正被 ${activePluginRuns(p).length} 个运行使用。停用前需要结束这些运行。</p><div class="notice">已有会话记录和文件保留；待处理请求会失效。</div>`;footer=button('保持启用','close-modal','secondary')+button('结束相关运行并停用','confirm-disable-plugin','danger',`data-id="${p.id}"`);
 }else if(m.type==='state'){
  title='当前原型状态';wide=true;body='<p class="form-help">用于评审状态变化。所有数据仅在本页内存中，刷新或重置即恢复示例。</p><pre class="state-dump">'+escape(JSON.stringify(snapshot(),null,2))+'</pre>';
 }else if(m.type==='scenarios'){
  title='模拟一个关键状态';body=`<p class="form-help">这些是原型演示控制，不是正式产品功能。作用于当前会话。</p><div class="scenario-grid">${button(icon('shield')+' 权限请求','scenario-permission','secondary')}${button(icon('chat')+' 结构化输入','scenario-form','secondary')}${button(icon('info')+' 连接中断','scenario-interrupt','secondary')}${button(icon('clock')+' 交付不确定','scenario-unknown','secondary')}${button(icon('close')+' 旧请求失效','scenario-expire','secondary')}${button(icon('check')+' 完成当前执行','scenario-finish','secondary')}</div><h3 class="subheading">Git 面板状态</h3><div class="scenario-grid">${button('有改动','scenario-git-ready','secondary')}${button('干净工作区','scenario-git-clean','secondary')}${button('读取失败','scenario-git-error','secondary')}</div><p class="form-help">Git 状态只作用于当前 Git 示例工作区。</p>${button('查看交互状态','state','ghost small')}`;
 }else if(m.type==='guide'){
  title='用一次真实工作来试用';body='<ol class="walkthrough-steps"><li><strong>先找到需要你处理的请求</strong><p>打开“待处理”，允许一次读取，或回答一个结构化问题。</p></li><li><strong>继续会话</strong><p>发送一条消息；执行时再发送一条，观察队列。比较“停止本轮”和“结束运行”。</p></li><li><strong>检查文件和改动</strong><p>在右侧展开目录、预览文件、加入输入。切到 Git 改动后比较不同来源。</p></li><li><strong>验证异常状态</strong><p>用“模拟状态”试连接中断、旧请求失效和 Git 读取失败。</p></li></ol><div class="notice">待确认：导航是否顺手、待处理与未读是否清楚、执行状态与工作区占用是否容易理解。</div>';
 }
 $('#overlays').innerHTML=`<div class="modal-backdrop"><section class="modal ${wide?'wide':''}" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><header class="modal-header"><h2 id="dialog-title">${title}</h2>${iconButton('close','关闭对话框','close-modal')}</header><div class="modal-body">${body}</div>${footer?`<footer class="modal-footer">${footer}</footer>`:''}</section></div>`;
}
function changeVariant(v){state.variant=v;state.inspector=defaultPanelOpen(v);const url=new URL(location.href);url.searchParams.set('variant',v);history.replaceState(null,'',url);record('切换布局',variants[v]);console.info('Aork prototype state',snapshot());render();}
function restore(s){
 if(alive(s)){state.modal=null;render();toast('当前运行仍在，无需恢复；可以继续对话或先结束运行');return;}
 const conflict=conflictingRun(s.workspace,s.id);
 if(conflict){toast('工作区仍由“'+conflict.title+'”占用。请结束该运行，或关联独立工作区的新会话。');state.modal=null;render();return;}
 cancelTimer(s.id);invalidate(s,'expired');s.generation++;s.run='ready';s.turn='idle';s.paused=true;s.messages.push({role:'system',text:'示例会话已恢复。原生历史保留，旧请求失效；排队输入需明确继续。'});state.modal=null;record('模拟恢复会话',s.title);render();
}
function openFile(path,fromGit=false) {
 const view=panelState();view.selected=path;view.tab='files';view.treeFocus=path;if(fromGit){view.query='';view.searchCollapsed=[];}
 const parts=path.split('/');for(let n=1;n<parts.length;n++){const folder=parts.slice(0,n).join('/');if(!view.expanded.includes(folder))view.expanded.push(folder);}
 render();focusTarget('.file-preview-header [data-action="close-preview"]');
}
function attachFile(path) {
 const session=current(),file=fileData().find(f=>f.path===path);if(!file){toast('当前工作区中没有这个文件');return;}
 state.attachments[session.id] ||= [];if(!state.attachments[session.id].includes(file.path))state.attachments[session.id].push(file.path);
 state.modal=null;if(inspectorOverlays())state.inspector=false;render();focusTarget('#composer');toast('已将 '+file.name+' 加入下一条输入');
}
function handleAction(action,el){
 const s=current(),id=el.dataset.id;
 switch(action){
 case 'toggle-sidebar':toggleNavigation();break;
 case 'toggle-project':state.foldedProjects ||= [];state.foldedProjects=state.foldedProjects.includes(id)?state.foldedProjects.filter(x=>x!==id):[...state.foldedProjects,id];render();break;
 case 'search-sessions':openModal('choose-session');break;
 case 'new-project-session':openModal('new-session',{draft:{title:'',project:el.dataset.project,workspace:'new',agent:'Claude',carry:true}});break;
 case 'workspace-context':{const w=workspace(id),session=state.sessions.find(x=>x.workspace===id);if(session)switchSession(session.id);else openModal('new-session',{draft:{title:'',project:w.project,workspace:w.id,agent:'Claude',carry:true}});break;}
 case 'view':state.view=['work','pending','projects','settings'].includes(el.dataset.view)?el.dataset.view:'work';state.mobileNav=false;state.modal=null;render();break;
 case 'project':{state.project=id;const next=state.sessions.find(x=>x.project===id);if(next)switchSession(next.id);else {state.view='projects';render();}break;}
 case 'session':state.modal=null;switchSession(id);break;
 case 'new-session':openModal('new-session');break;
 case 'new-project':openModal('new-project');break;
 case 'new-workspace':openModal('new-workspace',{project:el.dataset.project});break;
 case 'choose-agent':state.modal.draft.agent=el.dataset.agent;render();break;
 case 'choose-session':openModal('choose-session');break;
 case 'close-modal':closeModal();break;
 case 'mobile-nav':toggleNavigation();break;
 case 'toggle-inspector':setInspector(state.view!=='work' || !state.inspector);break;
 case 'tab':if(['files','git'].includes(el.dataset.tab)){panelState().tab=el.dataset.tab;render();}break;
 case 'settings-tab':state.settingsTab=el.dataset.tab;render();break;
 case 'open-plugin-settings':state.view='settings';state.settingsTab='plugins';state.mobileNav=false;render();focusTarget('#settings-tab-plugins');break;
 case 'resize-panel':state.panelWide=!state.panelWide;render();focusTarget('#workspace-resize-panel');break;
 case 'approve':resolveInteraction(id,true);break;
 case 'deny':resolveInteraction(id,false);break;
 case 'cancel-turn':stopTurn(s);break;
 case 'end-run':openModal('end-run');break;
 case 'confirm-end':endRun(s);state.modal=null;render();toast('运行已结束，工作区已释放');break;
 case 'session-menu':openModal('session-menu');break;
 case 'handoff':openModal('handoff');break;
 case 'restore':restore(s);break;
 case 'resume-queue':if(!canDispatch(s)){toast('请先恢复会话、处理请求，或等待当前轮次停止');break;}s.paused=false;dispatchNext(s);render();break;
 case 'queue':openModal('queue');break;
 case 'remove-queued':s.queue.splice(Number(el.dataset.index),1);record('移除尚未执行的输入',s.title);render();break;
 case 'close-preview':panelState().selected=null;render();focusTarget('.file-tree [tabindex="0"]');break;
 case 'file':openFile(el.dataset.path);break;
 case 'git-file':openFile(el.dataset.path,true);break;
 case 'toggle-folder':{const view=panelState(),path=el.dataset.path;view.treeFocus=path;if(view.query.trim())view.searchCollapsed=view.searchCollapsed.includes(path)?view.searchCollapsed.filter(p=>p!==path):[...view.searchCollapsed,path];else view.expanded=view.expanded.includes(path)?view.expanded.filter(p=>p!==path):[...view.expanded,path];render();break;}
 case 'collapse-folders':panelState().expanded=[];panelState().query='';panelState().treeFocus=null;render();focusTarget('.file-tree [tabindex="0"]');break;
 case 'clear-file-search':panelState().query='';render();focusTarget('#workspace-file-search');break;
 case 'toggle-diff':{const view=panelState();view.openChanges[view.source]=view.openChanges[view.source]===el.dataset.path?null:el.dataset.path;render();break;}
 case 'retry-git':panelState().gitStatus='ready';render();toast('已重新载入内存示例');break;
 case 'attach':openModal('attach');break;
 case 'attach-file':attachFile(el.dataset.path);break;
 case 'attach-selected':attachFile(panelState().selected);break;
 case 'remove-attachment':state.attachments[s.id].splice(Number(el.dataset.index),1);render();break;
 case 'profile':openModal('profile',{agent:el.dataset.agent});break;
 case 'model':openModal('model');break;
 case 'save-model':if(state.modal.type==='model')s.model=$('#model-choice').value;else state.profiles[state.modal.agent]=$('#model-choice').value;state.modal=null;render();toast('示例配置已更新，已有会话保持自己的选择');break;
 case 'plugin-config':openModal('plugin-config',{id});break;
 case 'save-plugin-config':{const m=state.modal;state.pluginConfig[m.id]={...m.draft};if(m.id==='git')for(const view of Object.values(state.workspaceViews))view.source=m.draft.defaultSource;closeModal();toast('插件配置已保存在本页内存中');break;}
 case 'toggle-plugin':{const p=state.plugins.find(x=>x.id===id);if(p.required && p.enabled){openModal('required-plugin',{id});break;}if(p.enabled && activePluginRuns(p).length){openModal('plugin-blocked',{id});break;}p.enabled=!p.enabled;render();toast('示例插件状态已更新');break;}
 case 'confirm-disable-plugin':{const p=state.plugins.find(x=>x.id===id);if(p.required){toast('当前工作台需要该基础能力，请保留启用');closeModal();break;}activePluginRuns(p).forEach(endRun);p.enabled=false;state.modal=null;render();toast('已结束相关运行并停用，已有记录保留');break;}
 case 'variant':changeVariant(el.dataset.variant);break;
 case 'guide':case 'scenarios':case 'state':openModal(action);break;
 case 'scenario-git-ready':case 'scenario-git-clean':case 'scenario-git-error':if(!workspace(s.workspace)?.git){toast('当前工作区不是 Git 仓库，请打开 Aork 工作台示例');break;}panelState().gitStatus=action.replace('scenario-git-','');state.modal=null;state.view='work';setInspector(true,'git');break;
 case 'scenario-permission':addRequest('permission');break;
 case 'scenario-form':addRequest('form');break;
 case 'scenario-interrupt':case 'scenario-unknown':cancelTimer(s.id);invalidate(s,'expired');s.run='terminated';s.turn=action==='scenario-unknown'?'delivery_unknown':'interrupted';s.paused=true;s.messages.push({role:'system',text:action==='scenario-unknown'?'发送窗口中断，交付结果无法确定，不会自动重发。':'示例连接中断，当前执行停止，排队输入保持暂停。'});state.modal=null;record('模拟中断',s.turn);render();break;
 case 'scenario-expire':invalidate(s,'expired');s.turn='interrupted';s.run='terminated';s.paused=true;cancelTimer(s.id);state.modal=null;record('旧请求失效',s.title);render();break;
 case 'scenario-finish':invalidate(s,'cancelled');s.turn='running';s.run='ready';state.modal=null;finishMock(s);break;
 case 'reset':{const v=state.variant,theme=state.theme;timers.forEach(clearTimeout);timers.clear();state=initialState(v);state.theme=theme;render();toast('已重置全部示例状态');break;}
 }
}
document.addEventListener('click',event=>{const el=event.target.closest('[data-action]');if(el && !el.disabled)handleAction(el.dataset.action,el);else if(event.target.classList.contains('modal-backdrop'))closeModal();});
document.addEventListener('input',event=>{
 if(event.target.id==='composer'){state.drafts[current().id]=event.target.value;resizeComposer();}
 if(event.target.id==='workspace-file-search'){panelState().query=event.target.value;panelState().selected=null;panelState().searchCollapsed=[];panelState().treeFocus=null;render();}
 if(event.target.dataset.modalField && state.modal?.draft){state.modal.draft[event.target.dataset.modalField]=event.target.type==='checkbox'?event.target.checked:event.target.value;if(['choose-session','attach'].includes(state.modal.type) && event.target.dataset.modalField==='query')render();}
});
document.addEventListener('change',event=>{
 if(event.target.id==='appearance-theme'){setTheme(event.target.value);return;}
 if(event.target.id==='git-source'){panelState().source=event.target.value;render();}
 if(event.target.dataset.interactionDraft){const i=state.interactions.find(x=>x.id===event.target.dataset.interactionDraft);if(i)i.draftAnswer=event.target.value;}
 if(event.target.dataset.modalField && state.modal?.draft){state.modal.draft[event.target.dataset.modalField]=event.target.type==='checkbox'?event.target.checked:event.target.value;if(event.target.dataset.modalField==='project'){state.modal.draft.workspace='new';render();}}
});
document.addEventListener('submit',event=>{
 const form=event.target;if(!form.dataset.form)return;event.preventDefault();const data=new FormData(form),s=current();
 if(form.dataset.form==='message'){
  const text=(state.drafts[s.id]||'').trim();if(!text){toast('先描述一下你想完成的工作');$('#composer')?.focus();return;}
  if(!alive(s)){toast('运行已结束，请先恢复会话或关联新会话');return;}
  const attachments=state.attachments[s.id]||[];state.drafts[s.id]='';state.attachments[s.id]=[];
  if(['running','waiting','cancelling'].includes(s.turn) || s.queue.length){s.queue.push({text,attachments});record('输入进入队列',s.title);render();toast(s.paused?'输入已排队，需明确继续':'输入已排队，将在当前轮次后继续');}
  else {s.paused=false;startMock(s,text,attachments);}
 }else if(form.dataset.form==='interaction')resolveInteraction(form.dataset.id,data.get('answer'));
 else if(form.dataset.form==='new-session'){
  const m=state.modal,d=m.draft;const name=String(data.get('title')||'').trim();if(!name)return;
  const existing=d.workspace==='new'?null:conflictingRun(d.workspace);if(existing){m.error='该工作区正被“'+existing.title+'”占用。请选择独立工作区，或先结束现有运行。';render();return;}
  let workspaceId=d.workspace;if(workspaceId==='new'){workspaceId='w'+(++state.counter);const candidate={id:workspaceId,project:d.project,name:name+' 的工作区',path:'/srv/aork/workspaces/work-'+state.counter};const conflict=conflictingPath(candidate.path);if(conflict){m.error='新目录与“'+conflict.title+'”的占用范围重叠，请先结束已有运行或另选工作区。';render();return;}state.workspaces.push(candidate);}
  const id='s'+(++state.counter);const messages=[];if(m.type==='handoff' && data.has('carry')){const refs=[...(state.attachments[s.id]||[])];state.attachments[id]=[...refs];messages.push({role:'system',text:'来自“'+s.title+'”的示例摘要。新 Agent 使用新的原生会话，不继承旧 ID。'});messages.push({role:'assistant',text:'收到示例上下文：'+(s.messages.filter(m=>m.role==='assistant').at(-1)?.text.slice(0,300)||'围绕原会话主题继续工作。'),attachments:refs});}
  state.sessions.push({id,project:d.project,workspace:workspaceId,title:name,agent:d.agent,model:state.profiles[d.agent],run:'ready',turn:'idle',unread:false,generation:1,queue:[],paused:false,messages});state.modal=null;switchSession(id);record('创建示例会话',name);toast('会话已创建，工作区已准备好');
 } else if(form.dataset.form==='workspace'){
  const name=String(data.get('name')||'').trim(),path=String(data.get('path')||'').trim();if(!name || !path)return;
  let p=state.modal.project;if(state.modal.type==='new-project'){p='p'+(++state.counter);state.projects.push({id:p,name,kind:'通用',color:'sage'});}
  state.workspaces.push({id:'w'+(++state.counter),project:p,name,path});state.project=p;state.modal=null;state.view='projects';record('创建示例工作环境',name);render();toast('已登记示例工作区，未创建真实目录');
 }
});
document.addEventListener('compositionstart',()=>{composing=true;});
document.addEventListener('compositionend',event=>{composing=false;if(event.target.id==='composer'){state.drafts[current().id]=event.target.value;resizeComposer();}else if(event.target.id==='workspace-file-search')panelState().query=event.target.value;else if(event.target.dataset.modalField && state.modal?.draft)state.modal.draft[event.target.dataset.modalField]=event.target.value;render();});
document.addEventListener('keydown',event=>{
 if(event.isComposing || composing)return;
 if(event.target.getAttribute('role')==='tab' && ['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){
  event.preventDefault();const tabs=[...event.target.closest('[role="tablist"]').querySelectorAll('[role="tab"]')],index=tabs.indexOf(event.target),next=event.key==='Home'?tabs[0]:event.key==='End'?tabs.at(-1):tabs[(index+(event.key==='ArrowRight'?1:tabs.length-1))%tabs.length],selector=focusSelector(next);
  handleAction(next.dataset.action,next);focusTarget(selector);return;
 }
 if(event.target.getAttribute('role')==='treeitem'){
  const item=event.target,items=[...document.querySelectorAll('.file-tree [role="treeitem"]')],index=items.indexOf(item),view=panelState();let target;
  if(event.key==='ArrowDown')target=items[Math.min(index+1,items.length-1)];
  else if(event.key==='ArrowUp')target=items[Math.max(index-1,0)];
  else if(event.key==='Home')target=items[0];
  else if(event.key==='End')target=items.at(-1);
  else if(event.key==='ArrowRight'){
   if(item.dataset.action==='toggle-folder' && item.getAttribute('aria-expanded')==='false'){event.preventDefault();handleAction('toggle-folder',item);return;}
   if(item.dataset.action==='toggle-folder')target=items[index+1];
  }else if(event.key==='ArrowLeft'){
   if(item.dataset.action==='toggle-folder' && item.getAttribute('aria-expanded')==='true'){event.preventDefault();handleAction('toggle-folder',item);return;}
   target=items.find(el=>el.dataset.path===item.dataset.parent);
  }
  if(['ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();if(target){view.treeFocus=target.dataset.path;for(const el of items)el.tabIndex=el===target?0:-1;target.focus();}return;}
 }

 if(state.modal){
  if(event.key==='Escape'){event.preventDefault();closeModal();return;}
  if(event.key==='Tab'){const controls=[...document.querySelectorAll('#overlays button, #overlays input, #overlays select, #overlays textarea, #overlays a[href]')].filter(el=>!el.disabled && el.offsetParent!==null);const first=controls[0],last=controls.at(-1);if(event.shiftKey && document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first?.focus();}}
  return;
 }
 if(inspectorOverlays()){if(event.key==='Escape'){event.preventDefault();setInspector(false);}else if(event.key==='Tab')trapFocus('.inspector',event);return;}
 if(window.innerWidth<800 && state.mobileNav){if(event.key==='Escape'){event.preventDefault();toggleNavigation();}else if(event.key==='Tab')trapFocus('.sidebar',event);return;}
 if(event.target.id==='composer' && event.key==='Enter' && !event.shiftKey && !event.isComposing){event.preventDefault();event.target.form.requestSubmit();return;}
 if(event.target.closest('input,textarea,select,[contenteditable="true"]'))return;
});
document.addEventListener('toggle',event=>{if(event.target.dataset?.activityKey && event.target.isConnected){state.activityOpen ||= {};state.activityOpen[event.target.dataset.activityKey]=event.target.open;}},true);
window.addEventListener('popstate',()=>{const v=new URLSearchParams(location.search).get('variant');if(variants[v]){state.variant=v;state.inspector=defaultPanelOpen(v);render();}});
window.addEventListener('resize',()=>{if(composing)return;resizeComposer();const compact=window.innerWidth<800,overlay=inspectorOverlays();if(compact===renderedViewport?.compact && overlay===renderedViewport?.overlay)return;if(compact && !renderedViewport?.compact)state.inspector=false;if(!compact)state.mobileNav=false;render();if(inspectorOverlays())focusTarget('.inspector button');});
themeMedia.addEventListener('change',()=>{if(state.theme==='system')render();});
render();console.info('Aork prototype state',snapshot());
})();
