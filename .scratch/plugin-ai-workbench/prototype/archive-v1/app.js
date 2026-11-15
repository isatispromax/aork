/* THROWAWAY UI PROTOTYPE. Three structural layouts on ?variant=A|B|C.
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
const variants = {A:'项目工作台',B:'待处理优先',C:'会话专注'};
let timers = new Map();
let toastTimer;
let lastTrigger;
function focusSelector(el) {
 if(!el)return null;if(el.id)return '#'+CSS.escape(el.id);
 if(!el.dataset?.action)return null;
 let selector='[data-action="'+CSS.escape(el.dataset.action)+'"]';
 for(const key of ['id','variant','agent','name','index','view','project','tab'])if(el.dataset[key]!==undefined)selector+='[data-'+key+'="'+CSS.escape(el.dataset[key])+'"]';
 if(el.getAttribute('aria-label'))selector+='[aria-label="'+CSS.escape(el.getAttribute('aria-label'))+'"]';
 return selector;
}
const seed = () => ({
 profiles:{Claude:'Sonnet · 示例',Codex:'默认配置 · 示例'},
 projects:[{id:'p1',name:'研究资料',kind:'研究',color:'sage'},{id:'p2',name:'Aork 工作台',kind:'编程',color:'blue'},{id:'p3',name:'个人文档',kind:'文档',color:'sand'}],
 workspaces:[{id:'w1',project:'p1',name:'用户访谈',path:'/srv/aork/workspaces/research'},{id:'w2',project:'p2',name:'工作台设计',path:'/srv/aork/workspaces/aork'},{id:'w3',project:'p3',name:'周报资料',path:'/srv/aork/workspaces/documents'}],
 sessions:[
 {id:'s1',project:'p1',workspace:'w1',title:'整理开发者访谈',agent:'Claude',model:'Sonnet · 示例',run:'ready',turn:'waiting',unread:false,generation:1,queue:[],paused:false,messages:[{role:'user',text:'把这周的 6 份开发者访谈整理成一份研究摘要。重点关注用户如何切换项目、等待 Agent，以及找回工作结果。请保留原话出处。'},{role:'assistant',text:'我会先梳理访谈中的共同行为，再把发现整理成可追溯的建议。\n\n计划分三步：读取资料、归纳主题、生成摘要。'},{role:'tool',text:'已定位 6 份访谈资料 · 等待你的读取许可'}]},
 {id:'s2',project:'p2',workspace:'w2',title:'梳理工作台导航',agent:'Codex',model:'默认配置 · 示例',run:'ready',turn:'waiting',unread:false,generation:1,queue:[],paused:false,messages:[{role:'user',text:'梳理项目、会话和待处理之间的导航关系，给出一个简单的结构建议。'},{role:'assistant',text:'我已经整理出两个方向。为了让建议更贴近你的使用方式，需要先确认一个选择。'}]},
 {id:'s3',project:'p1',workspace:'w1',title:'提炼访谈问题清单',agent:'Claude',model:'Sonnet · 示例',run:'terminated',turn:'completed',unread:true,generation:1,queue:[],paused:false,messages:[{role:'user',text:'帮我把下次访谈需要追问的问题列出来。'},{role:'assistant',text:'已整理成 8 个开放式问题，覆盖任务切换、等待与结果管理。\n\n建议先请受访者回顾最近一次真实工作，再追问具体操作。结果已放在右侧产物中。'}]},
 {id:'s4',project:'p3',workspace:'w3',title:'整理本周工作记录',agent:'Claude',model:'Sonnet · 示例',run:'terminated',turn:'interrupted',unread:false,generation:1,queue:[{text:'再整理一份下周计划',attachments:[]}],paused:true,messages:[{role:'user',text:'根据这些工作记录整理一份周报。'},{role:'assistant',text:'我已读完前两份记录，正在归纳本周进展。'},{role:'system',text:'连接已中断。已收到的内容仍保留，排队输入尚未继续。'}]}
 ],
 interactions:[{id:'i1',session:'s1',type:'permission',status:'pending',generation:1,title:'允许读取访谈资料吗？',description:'Claude 希望读取当前工作区中的 6 份访谈文件，用于生成这次研究摘要。'},{id:'i2',session:'s2',type:'form',status:'pending',generation:1,title:'你希望优先看到什么？',description:'这个选择会影响主导航的组织方式。'}],
 artifacts:[{id:'a1',session:'s3',project:'p1',name:'下一轮访谈提纲.md',version:'v1',type:'文档',summary:'8 个围绕真实行为的追问',content:'# 下一轮访谈提纲\n\n1. 请回顾你最近一次使用 Agent 完成工作的经历。\n2. 当 Agent 等待输入时，你如何注意到它？\n3. 你怎样找回上一次生成的结果？\n4. 同时进行多个项目时，最容易混淆什么？\n\n来源：示例访谈 01—06。本文件是交互原型的示例产物。'}],
 plugins:[{id:'files',name:'文件与工作区',description:'准备资料、浏览文件和管理工作环境',enabled:true,required:true,icon:'folder'}, {id:'sessions',name:'会话与交互',description:'与 Agent 交流，处理权限与结构化请求',enabled:true,required:true,icon:'chat'}, {id:'docs',name:'文档与产物',description:'登记版本、预览结果并再次作为上下文',enabled:true,required:false,icon:'file'}, {id:'git',name:'Git 与差异',description:'为编程项目提供改动浏览与差异视图',enabled:true,required:false,icon:'link'}]
});
const initialVariant = new URLSearchParams(location.search).get('variant');
let state = {...seed(),variant:variants[initialVariant] ? initialVariant : 'A',view:'work',project:'p1',session:'s1',inspector:(!variants[initialVariant] || initialVariant==='A') && window.innerWidth>=1100,tab:'files',preview:null,modal:null,mobileNav:false,drafts:{},attachments:{},events:[],counter:10,signedIn:true};
const current = () => state.sessions.find(s=>s.id===state.session) || state.sessions[0];
const project = id => state.projects.find(p=>p.id===id);
const workspace = id => state.workspaces.find(w=>w.id===id);
const pending = sid => state.interactions.filter(i=>i.status==='pending' && (!sid || i.session===sid));
const artifactsFor = s => state.artifacts.filter(a=>a.session===s.id || a.project===s.project);
const alive = s => s.run==='ready' || s.run==='stopping' || s.run==='unknown';
const canDispatch = s => s.run==='ready' && ['idle','completed','cancelled'].includes(s.turn) && !pending(s.id).length;
function normalizedPath(path) { const parts=[];for(const part of String(path).split('/')){if(!part || part==='.')continue;if(part==='..')parts.pop();else parts.push(part);}return '/'+parts.join('/'); }
function conflictingPath(path, exceptId) { const a=normalizedPath(path);return state.sessions.find(other=>{if(other.id===exceptId || !alive(other))return false;const b=normalizedPath(workspace(other.workspace)?.path);return a===b || a==='/' || b==='/' || a.startsWith(b+'/') || b.startsWith(a+'/');}); }
function conflictingRun(workspaceId, exceptId) { const target=workspace(workspaceId);return target?conflictingPath(target.path,exceptId):null; }

const statusLabel = s => ({waiting:'等你回复',running:'执行中',cancelling:'取消中',completed:'已完成',cancelled:'本轮已停止',interrupted:'已中断',delivery_unknown:'交付不确定',idle:'准备就绪'})[s.turn] || '准备就绪';
const record = (action, detail='') => { state.events.unshift({action,detail,time:new Date().toLocaleTimeString('zh-CN',{hour12:false})}); state.events=state.events.slice(0,24); };
function toast(text) { $('#toast').textContent=text; $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),2800); }
function snapshot() { return {variant:state.variant,view:state.view,project:state.project,session:state.session,sessions:state.sessions.map(({id,title,workspace,agent,run,turn,generation,queue,paused,unread})=>({id,title,workspace,agent,run,turn,generation,queue,paused,unread})),interactions:state.interactions,artifacts:state.artifacts.map(({content,...a})=>a),plugins:state.plugins,profiles:state.profiles,attachments:state.attachments,events:state.events}; }
function cancelTimer(id) { clearTimeout(timers.get(id)); timers.delete(id); }
function invalidate(s,status='cancelled') { state.interactions.forEach(i=>{if(i.session===s.id && i.status==='pending')i.status=status;}); }
function switchSession(id) {
 const s=state.sessions.find(x=>x.id===id); if(!s)return;
 state.session=id;state.project=s.project;state.view='work';state.preview=null;state.mobileNav=false;s.unread=false;record('打开会话',s.title);render();
}
function startMock(s,text,attachments=[]) {
 cancelTimer(s.id); s.run='ready';s.turn='running';s.unread=false;
 s.messages.push({role:'user',text,attachments});
 const generation=s.generation;
 record('受理输入',`${s.title} · 开始模拟执行`);render();
 timers.set(s.id,setTimeout(()=>{
  if(s.generation!==generation || s.turn!=='running')return;
  s.messages.push({role:'tool',text:'已读取工作区示例资料 · 正在组织结果'});render();
  timers.set(s.id,setTimeout(()=>finishMock(s),3300));
 },1800));
}
function finishMock(s) {
 cancelTimer(s.id); if(s.turn!=='running')return;
 s.turn='completed';
 s.messages.push({role:'assistant',text:'已完成这次示例处理。\n\n• 把需要行动的请求与普通未读回复分开。\n• 在会话中明确工作区、Agent 和执行状态。\n• 让结果保留来源，并能直接用于下一次工作。\n\n右侧已生成一份带来源的摘要，你可以打开、下载或加入下一条输入。'});
 if(state.plugins.find(p=>p.id==='docs').enabled) {
  const id='a'+(++state.counter);state.artifacts.push({id,session:s.id,project:s.project,name:s.title+' · 摘要.md',version:'v1',type:'文档',summary:'3 条发现 · 6 份示例资料',content:'# '+s.title+'\n\n## 主要发现\n\n1. 将待处理请求与普通未读分开。\n2. 明确工作区、Agent 与执行状态。\n3. 保留产物来源，支持后续复用。\n\n## 资料来源\n\n示例访谈 01、03、06。此文档由内存模拟流程生成，不代表真实研究。'});
 }
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
 s.messages.push({role:'system',text:'运行已结束，工作区占用已释放。已有消息和产物仍保留。'});record('结束运行并释放工作区',s.title);
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
function sidebar() {
 const total=pending().length;
 return `<aside class="sidebar" ${window.innerWidth<800 && !state.mobileNav?'inert aria-hidden="true"':''}><button type="button" class="nav-mobile-close icon-button" data-action="mobile-nav" aria-label="关闭导航">${icon('close')}</button><a class="brand" href="?variant=${state.variant}" aria-label="Aork 原型首页"><span class="brand-mark">a</span><span class="nav-label">aork<span class="brand-caption">你的 AI 工作环境</span></span></a>
 <button id="new-session-nav" class="button primary new-session" aria-label="新建会话" data-action="new-session">${icon('plus')}<span class="nav-label">新建会话</span></button>
 <nav aria-label="主导航"><button class="nav-item ${state.view==='pending'?'active':''}" data-action="view" data-view="pending" title="待处理" aria-label="待处理">${icon('inbox')}<span class="nav-label">待处理</span>${total?`<span class="count">${total}</span>`:''}</button>
 <button class="nav-item ${state.view==='projects'?'active':''}" data-action="view" data-view="projects" title="项目" aria-label="项目">${icon('folder')}<span class="nav-label">项目</span></button></nav>
 <div class="sidebar-section"><div class="section-label"><span class="nav-label">项目</span>${iconButton('plus','新建项目','new-project')}</div>${state.projects.map(p=>`<button class="project-item ${p.id===state.project && state.view==='work'?'active':''}" data-action="project" data-id="${p.id}" title="${escape(p.name)}"><span class="project-icon ${p.color}">${escape(p.name.slice(0,1))}</span><span class="nav-label">${escape(p.name)}</span></button>`).join('')}</div>
 <div class="sidebar-bottom"><button class="nav-item ${state.view==='plugins'?'active':''}" data-action="view" data-view="plugins" title="插件" aria-label="插件">${icon('plug')}<span class="nav-label">插件</span></button><button class="nav-item ${state.view==='settings'?'active':''}" data-action="view" data-view="settings" title="设置" aria-label="设置">${icon('settings')}<span class="nav-label">设置</span></button><button class="nav-item account" data-action="account" title="示例账号"><span class="avatar">Y</span><span class="nav-label">我的工作台<span class="muted account-caption">个人服务器 · 示例</span></span>${icon('dots')}</button></div></aside>`;
}
function topbar() {
 const labels={work:project(state.project)?.name,pending:'待处理',projects:'项目',plugins:'插件',settings:'设置'};
 return `<header class="topbar"><div class="breadcrumb">${iconButton('menu','打开导航','mobile-nav').replace('class="icon-button"','class="icon-button mobile-menu"')}<span>Aork</span>${icon('chevron')}<strong>${escape(labels[state.view] || '工作台')}</strong></div><div class="topbar-actions"><span class="prototype-tag"><span class="status-dot"></span>交互原型 · 示例数据</span>${button('操作引导','guide','ghost small')}${iconButton('panel','资料与产物面板','toggle-inspector')}</div></header>`;
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
function message(m,s) {
 if(m.role==='tool' || m.role==='system')return `<div class="tool-event ${m.role}">${icon(m.role==='tool'?'check':'info')}<span>${escape(m.text)}</span></div>`;
 return `<article class="message ${m.role}"><div class="message-avatar ${m.role==='assistant'?'agent-avatar':''}">${m.role==='user'?'Y':s.agent.slice(0,1)}</div><div class="message-body"><div class="message-meta"><strong>${m.role==='user'?'你':s.agent}</strong><span>${m.role==='user'?'工作台':'Agent'}</span></div><div class="message-text">${escape(m.text).replace(/\n/g,'<br>')}</div>${m.attachments?.length?`<div class="attachment-chips">${m.attachments.map(a=>`<span class="chip">${icon('file')}${escape(a)}</span>`).join('')}</div>`:''}</div></article>`;
}
function conversation() {
 const s=current(), w=workspace(s.workspace);const active=['running','waiting','cancelling'].includes(s.turn),recentArtifact=state.artifacts.filter(a=>a.session===s.id).at(-1);
 const intro=state.variant==='C'?`<div class="focus-session-picker">${button(icon('chat')+' '+escape(s.title)+' '+icon('down'),'choose-session','ghost')}</div>`:'';
 return `<main class="conversation">${intro}<header class="conversation-header"><div class="heading-title"><span class="eyebrow">${escape(project(s.project).kind)}工作区</span><h1>${escape(s.title)} ${iconButton('down','切换会话','choose-session')}</h1><div class="session-subtitle"><span class="agent-pill">${s.agent.slice(0,1)} <strong>${s.agent}</strong></span><span>${escape(w?.name || '')}</span><span class="status-pill ${s.turn}"><span class="status-dot ${s.turn}"></span>${escape(statusLabel(s))}</span></div></div><div class="session-actions">${iconButton('dots','会话操作','session-menu')}${iconButton('panel','打开资料与产物','toggle-inspector')}</div></header>
 <div class="messages" id="messages"><div class="day-divider">今天 · ${s.agent} 在服务器工作区中工作</div>
 ${s.turn==='interrupted'||s.turn==='delivery_unknown'?`<div class="notice warning"><strong>${s.turn==='delivery_unknown'?'最后一条输入的交付结果不确定':'这次执行已中断'}</strong><p>已保存的内容仍在。恢复连接不会自动重发输入或继续队列。</p><div>${button('恢复会话','restore','secondary small')}${button('关联新会话','handoff','ghost small')}</div></div>`:''}
 ${s.messages.map(m=>message(m,s)).join('')}
 ${state.interactions.filter(i=>i.session===s.id).slice(-2).map(interactionCard).join('')}
 ${s.turn==='running'?`<div class="thinking"><span class="thinking-dot"></span><span>${s.agent} 正在整理资料</span><span class="muted">模拟执行</span></div>`:''}
 ${s.turn==='cancelling'?'<div class="notice">正在停止本轮，请等待终止结果…</div>':''}
 ${recentArtifact && s.turn==='completed'?`<button class="artifact-inline" data-action="artifact" data-id="${recentArtifact.id}">${icon('file')}<span><strong>${escape(recentArtifact.name)}</strong><small>${escape(recentArtifact.version)} · 查看产物</small></span>${icon('chevron')}</button>`:''}
 ${s.run==='terminated' && s.turn!=='interrupted'?'<div class="notice"><span>运行已结束，工作区占用已释放。</span> '+button('继续此会话','restore','ghost small')+'</div>':''}
 </div><div class="composer-area">${s.queue.length?`<div class="queue-strip">${icon('clock')}<span>${s.queue.length} 条输入${s.paused?'已暂停':'排队中'}</span><span class="muted">${escape(s.queue[0].text.slice(0,24))}</span>${button('查看队列','queue','ghost small')}${s.paused?button('继续队列','resume-queue','ghost small',canDispatch(s)?'':'disabled'):''}</div>`:''}
 ${(state.attachments[s.id]||[]).length?`<div class="attachment-chips">${state.attachments[s.id].map((a,n)=>`<button class="chip" data-action="remove-attachment" data-index="${n}">${icon('file')}${escape(a)} ${icon('close')}</button>`).join('')}</div>`:''}
 <form class="composer" data-form="message"><textarea id="composer" class="composer-input" rows="3" placeholder="${active?'补充下一步，输入会进入队列…':'描述你想完成的工作…'}" aria-label="消息输入">${escape(state.drafts[s.id]||'')}</textarea><div class="composer-footer"><div class="composer-tools">${iconButton('attach','添加工作区资料','attach')}${button(escape(s.model)+' '+icon('down'),'model','ghost small')}<span class="muted composer-tools-label">${state.plugins.filter(p=>p.enabled).length} 项能力可用</span></div><div class="composer-tools">${active?iconButton('stop','停止当前轮次','cancel-turn'):''}<button type="submit" class="send-button" aria-label="${active?'加入队列':'发送消息'}" title="${active?'加入队列':'发送消息'}">${icon('arrow')}</button></div></div></form>
 <div class="composer-hint"><span>${alive(s)?'工作区由当前运行占用':'工作区未被当前运行占用'} · ${escape(s.agent)}</span>${alive(s)?'<button class="link-button" data-action="end-run">结束运行</button>':'<span>Enter 发送 · Shift + Enter 换行</span>'}</div></div></main>`;
}
function fileData() { const w=workspace(current().workspace);if(w?.demoFiles)return w.demoFiles;return ({w1:[{id:'f1',name:'访谈原文 01.md',detail:'访谈记录 · 4.2 KB'},{id:'f2',name:'访谈原文 03.md',detail:'访谈记录 · 3.8 KB'},{id:'f3',name:'研究背景.md',detail:'背景资料 · 2.1 KB'},{id:'f4',name:'项目说明.md',detail:'工作说明 · 1.5 KB'}],w2:[{id:'f5',name:'README.md',detail:'项目说明 · 2.4 KB'},{id:'f6',name:'navigation.tsx',detail:'界面代码 · 3.1 KB'}],w3:[{id:'f7',name:'本周工作记录.md',detail:'工作记录 · 2.8 KB'}]})[w?.id] || []; }
function inspector() {
 const s=current(), arts=artifactsFor(s),a=state.artifacts.find(x=>x.id===state.preview);
 return `<aside class="inspector open"><div class="inspector-heading"><h2>工作上下文</h2>${iconButton('close','关闭上下文面板','toggle-inspector')}</div><div class="tabs" role="tablist"><button class="tab ${state.tab==='files'?'active':''}" role="tab" aria-selected="${state.tab==='files'}" data-action="tab" data-tab="files">资料 <span>${fileData().length}</span></button><button class="tab ${state.tab==='artifacts'?'active':''}" role="tab" aria-selected="${state.tab==='artifacts'}" data-action="tab" data-tab="artifacts">产物 <span>${arts.length}</span></button></div>
 <div class="inspector-content">${a?`<div class="file-preview"><button class="link-button" data-action="close-preview">${icon('back')} 返回产物</button><div class="preview-title">${icon('file')}<h3>${escape(a.name)}</h3><span class="badge">${a.version}</span></div><div class="preview-content">${escape(a.content).replace(/\n/g,'<br>')}</div><div class="form-actions">${button('加入输入','reuse-artifact','primary small',`data-id="${a.id}"`)}${button(icon('download')+' 下载','download','secondary small',`data-id="${a.id}"`)}</div><p class="form-help">来源：${escape(state.sessions.find(x=>x.id===a.session)?.title)}<br>版本固定 · 示例产物</p></div>`:state.tab==='files'?`<div class="section-label">${escape(workspace(s.workspace)?.name)}</div><div class="file-list">${fileData().map(f=>`<button class="file-row" data-action="file" data-id="${f.id}">${icon('file')}<span><strong>${f.name}</strong><small>${f.detail}</small></span>${icon('chevron')}</button>`).join('') || '<div class="empty-state"><p>新工作区还没有资料</p>'+button('添加示例文件','demo-file','secondary small')+'</div>'}</div><div class="notice small">${icon('folder')}<span class="mono">${escape(workspace(s.workspace)?.path)}</span></div>`:`<div class="section-label">明确版本，随时复用</div>${arts.map(a=>`<button class="artifact-row" data-action="artifact" data-id="${a.id}">${icon('file')}<span><strong>${escape(a.name)}</strong><small>${a.version} · ${escape(a.summary)}</small></span></button>`).join('') || '<div class="empty-state">'+icon('file')+'<h3>结果会留在这里</h3><p>完成一次示例执行后，可以预览并复用产物。</p></div>'}`}</div><div class="inspector-footer">${icon('shield')}<span>只使用当前工作区与已选资料</span></div></aside>`;
}
function projectsPage() { return `<main class="content-page"><div class="page-heading"><div><span class="eyebrow">把工作组织起来</span><h1>项目</h1><p class="page-lead">项目可以是代码，也可以是一组长期关心的问题。</p></div>${button(icon('plus')+' 新建项目','new-project','primary')}</div><div class="project-grid">${state.projects.map(p=>`<article class="project-card"><div class="project-card-header"><span class="project-icon ${p.color}">${escape(p.name.slice(0,1))}</span><span class="badge">${p.kind}</span></div><h2>${escape(p.name)}</h2><p class="muted">${state.sessions.filter(s=>s.project===p.id).length} 个会话 · ${state.workspaces.filter(w=>w.project===p.id).length} 个工作区</p>${state.workspaces.filter(w=>w.project===p.id).map(w=>`<div class="workspace-row">${icon('folder')}<span>${escape(w.name)}<small class="mono">${escape(w.path)}</small></span></div>`).join('')}<div class="form-actions">${button('打开项目','project','secondary small',`data-id="${p.id}"`)}${button('新建工作区','new-workspace','ghost small',`data-project="${p.id}"`)}</div></article>`).join('')}</div></main>`; }
function pendingPage() { return `<main class="content-page"><div class="page-heading"><div><span class="eyebrow">保持工作向前</span><h1>待处理 <span class="muted">${pending().length}</span></h1><p class="page-lead">这里只显示仍可响应的请求。普通回复放在未读中。</p></div></div><div class="pending-list">${pending().map(i=>{const s=state.sessions.find(x=>x.id===i.session);return `<article class="pending-row"><span class="plugin-icon">${icon(i.type==='permission'?'shield':'chat')}</span><div><span class="eyebrow">${escape(project(s.project).name)} · ${s.agent}</span><h2>${escape(i.title)}</h2><p class="muted">${escape(s.title)} · ${i.type==='permission'?'等待许可':'需要补充信息'}</p></div>${button('查看并回应 '+icon('chevron'),'session','secondary',`data-id="${s.id}"`)}</article>`;}).join('') || '<div class="empty-state">'+icon('check')+'<h2>现在没有需要回应的请求</h2><p>你可以继续已有会话，或开始新的工作。</p></div>'}</div><h2 class="subheading">未读回复 <span class="muted">${state.sessions.filter(s=>s.unread).length}</span></h2>${state.sessions.filter(s=>s.unread).map(s=>`<article class="pending-row"><span class="unread-dot"></span><div><h3>${escape(s.title)}</h3><p class="muted">${s.agent} 已完成回复 · 打开后标记为已读</p></div>${button('阅读回复','session','ghost',`data-id="${s.id}"`)}</article>`).join('') || '<p class="muted">没有未读回复</p>'}</main>`; }
function pluginsPage() { return `<main class="content-page"><div class="page-heading"><div><span class="eyebrow">按工作需要组合能力</span><h1>插件</h1><p class="page-lead">停用能力会撤下对应入口，已有会话和产物仍保留。</p></div><span class="badge">默认组合 · 示例</span></div><div class="plugin-list">${state.plugins.map(p=>`<article class="plugin-row"><span class="plugin-icon">${icon(p.icon)}</span><div class="plugin-description"><h2>${p.name}${p.required?'<span class="badge">基础能力</span>':''}</h2><p>${p.description}</p><small class="muted">Aork · v0.1 · ${p.enabled?'已启用':'已停用'}</small></div><button class="toggle ${p.enabled?'on':''}" role="switch" aria-checked="${p.enabled}" aria-label="${p.enabled?'停用':'启用'}${p.name}" data-action="toggle-plugin" data-id="${p.id}"><span></span></button></article>`).join('')}</div><div class="notice">${icon('info')}<span>运行正在使用某项能力时，会先提示停止受影响的运行。</span></div></main>`; }
function settingsPage() { return `<main class="content-page"><div class="page-heading"><div><span class="eyebrow">你的执行环境</span><h1>设置</h1><p class="page-lead">从 Agent 配置中选择接入方式，会话保留创建时的选择。</p></div></div><div class="settings-grid">${['Claude','Codex'].map(agent=>`<article class="settings-card"><span class="agent-avatar">${agent[0]}</span><h2>${agent}</h2><p class="muted">${agent==='Claude'?'研究与文档':'编程与文件处理'} · 示例 Profile</p><div class="workspace-row">${icon('settings')}${escape(state.profiles[agent])}</div><div class="workspace-row">${icon('shield')}凭据：服务器引用 · 示例</div><div class="workspace-row">${icon('folder')}状态目录：独立保存</div>${button('查看配置','profile','secondary',`data-agent="${agent}"`)}</article>`).join('')}</div><div class="notice">本原型不接入真实账号，也不收集真实凭据。所有连接状态仅用于评审交互。</div></main>`; }
function toolbar() { return `<aside class="prototype-toolbar" aria-label="原型评审工具"><span class="prototype-label">原型</span>${iconButton('back','上一个布局','previous-variant')}${Object.entries(variants).map(([id,name])=>`<button class="variant-button ${state.variant===id?'active':''}" data-action="variant" data-variant="${id}" title="${name}" aria-label="${id} ${name}"><strong>${id}</strong><span>${name}</span></button>`).join('')}${iconButton('chevron','下一个布局','next-variant')}<span class="toolbar-divider"></span><button class="variant-button" data-action="scenarios">模拟状态</button><button class="variant-button" data-action="state">交互状态</button>${iconButton('restart','重置原型','reset')}</aside>`; }
function loginPage() { return `<main class="login-page"><div class="login-card"><a class="brand" href="?variant=${state.variant}"><span class="brand-mark">a</span>aork</a><span class="eyebrow">个人远程工作台</span><h1>回到你的工作</h1><p class="page-lead">项目、会话和工作结果，都留在同一个地方。</p><label class="form-label">账号</label><input class="form-input" value="demo@aork.local" readonly aria-label="示例账号"><label class="form-label">密码</label><input class="form-input" value="example-only" type="password" readonly aria-label="示例密码">${button('使用示例账号进入 '+icon('arrow'),'login','primary')}<p class="form-help">交互原型，未连接认证服务。请勿输入真实凭据。</p></div></main>`; }
function render() {
 const active=document.activeElement; const focus=focusSelector(active); const selection=typeof active?.selectionStart==='number'?[active.selectionStart,active.selectionEnd]:null;
 const oldMessages=$('#messages'),scroll=oldMessages?.scrollTop;const atBottom=!oldMessages || oldMessages.scrollHeight-oldMessages.clientHeight-oldMessages.scrollTop<100;
 let page=''; if(state.view==='work'){page=(state.variant==='A'?sessionRail():state.variant==='B'?inboxPanel():'')+conversation()+(state.inspector?inspector():'');}else page=({projects:projectsPage,pending:pendingPage,plugins:pluginsPage,settings:settingsPage}[state.view]||projectsPage)();
 $('#app').innerHTML=(state.signedIn?`<div class="app-shell variant-${state.variant.toLowerCase()} ${state.mobileNav?'nav-open':''} ${state.inspector && state.view==='work'?'has-inspector inspector-open':''}">${sidebar()}<section class="workspace">${topbar()}<div class="work-area">${page}</div></section></div>`:loginPage())+toolbar();
 renderModal();$('#app').inert=!!state.modal;
 if(focus){const el=$(focus);if(el && !el.closest('[inert]')){el.focus({preventScroll:true});if(selection && typeof el.setSelectionRange==='function'){try{el.setSelectionRange(...selection);}catch{ /* select controls do not expose text selections */ }}}}
 const messages=$('#messages');if(messages)messages.scrollTop=atBottom?messages.scrollHeight:scroll;
}
function openModal(type,extra={}) {lastTrigger=focusSelector(document.activeElement);state.modal={type,...extra};render();requestAnimationFrame(()=>$('#overlays input, #overlays select, #overlays button')?.focus());}
function closeModal() {state.modal=null;render();(lastTrigger && $(lastTrigger) || $('#new-session-nav'))?.focus();}
function inputField(label,name,value='',placeholder='') {return `<div class="field"><label class="form-label" for="modal-${name}">${escape(label)}</label><input class="form-input" id="modal-${name}" name="${name}" data-modal-field="${name}" value="${escape(value)}" placeholder="${escape(placeholder)}" required></div>`;}
function renderModal() {
 const m=state.modal;if(!m){$('#overlays').innerHTML='';return;}
 let title='',body='',footer='',wide=false;
 if(m.type==='new-session' || m.type==='handoff'){
  title=m.type==='handoff'?'关联新的会话':'开始新的会话';m.draft ||= {title:m.type==='handoff'?current().title+' · 继续':'',project:state.project,workspace:'new',agent:m.type==='handoff'?(current().agent==='Claude'?'Codex':'Claude'):'Claude',carry:true};
  const d=m.draft;body=`<form id="new-session-form" data-form="new-session">${m.type==='handoff'?'<div class="notice">原会话保持不变。新 Agent 接收你选择的上下文，不继承原生会话 ID。</div>':''}${inputField('会话名称','title',d.title,'例如：整理本周的研究发现')}<div class="field"><label class="form-label" for="modal-project">项目</label><select class="form-select" id="modal-project" name="project" data-modal-field="project">${state.projects.map(p=>`<option value="${p.id}" ${p.id===d.project?'selected':''}>${escape(p.name)}</option>`).join('')}</select></div><div class="field"><label class="form-label" for="modal-workspace">工作区</label><select class="form-select" id="modal-workspace" name="workspace" data-modal-field="workspace"><option value="new">新建独立工作区（适合并行工作）</option>${state.workspaces.filter(w=>w.project===d.project).map(w=>`<option value="${w.id}" ${w.id===d.workspace?'selected':''}>${escape(w.name)}${state.sessions.some(s=>s.workspace===w.id && alive(s))?' · 被占用':''}</option>`).join('')}</select><p class="form-help">相同或重叠目录一次只能由一个运行写入。</p></div><label class="form-label">Agent</label><div class="radio-cards">${['Claude','Codex'].map(agent=>`<button type="button" class="choice-card ${d.agent===agent?'selected':''}" data-action="choose-agent" data-agent="${agent}"><span class="agent-avatar">${agent[0]}</span><strong>${agent}</strong><small>${agent==='Claude'?'研究与文档':'编程与文件处理'}</small></button>`).join('')}</div><div class="field"><label class="form-label">启用能力</label><div class="attachment-chips">${state.plugins.filter(p=>p.enabled).map(p=>`<span class="chip">${icon('check')}${p.name}</span>`).join('')}</div></div>${m.type==='handoff'?`<label class="checkbox-row"><input type="checkbox" name="carry" data-modal-field="carry" ${d.carry?'checked':''}> 携带原会话的示例摘要与已选产物引用</label><p class="form-help">已选引用：${escape((state.attachments[current().id]||[]).join('、')||'暂无；可先在产物面板加入输入')}</p>`:''}${m.error?`<div class="notice warning">${escape(m.error)}</div>`:''}</form>`;
  footer=button('取消','close-modal','secondary')+'<button type="submit" form="new-session-form" class="button primary">创建会话 '+icon('arrow')+'</button>';
 }else if(m.type==='new-project' || m.type==='new-workspace'){
  title=m.type==='new-project'?'新建项目':'添加工作区';m.draft||={name:'',path:''};body=`<form id="workspace-form" data-form="workspace">${inputField(m.type==='new-project'?'项目名称':'工作区名称','name',m.draft.name,'给这组工作一个名字')}${inputField('服务器目录（示例）','path',m.draft.path,'/srv/aork/workspaces/my-project')}<p class="form-help">这里只登记示例目录，不会创建或读写服务器文件。</p></form>`;footer=button('取消','close-modal','secondary')+'<button form="workspace-form" type="submit" class="button primary">创建</button>';
 }else if(m.type==='end-run'){
  title='结束运行并释放工作区？';body=`<p>${escape(current().agent)} 将停止本会话的执行，待处理请求失效，排队输入保留但暂停。</p><div class="notice">已有消息、文件和产物不会删除。只有确认相关执行停止后，工作区才能交给其他会话。</div>`;footer=button('继续保留运行','close-modal','secondary')+button('结束运行','confirm-end','danger');
 }else if(m.type==='session-menu'){
  title='会话操作';body=`<div class="scenario-grid">${button(icon('restart')+' 恢复会话','restore','secondary')}${button(icon('chat')+' 关联新会话','handoff','secondary')}${button(icon('exit')+' 结束运行','end-run','secondary')}</div><p class="form-help">停止本轮只取消当前输入；结束运行才释放工作区。</p>`;
 }else if(m.type==='queue'){
  title='尚未执行的输入';body=current().queue.map((q,n)=>`<div class="pending-row"><div><strong>${n+1}. ${escape(q.text)}</strong><p class="muted">${escape(q.attachments.join('、')||'无附件')}</p></div>${button('移除','remove-queued','ghost small',`data-index="${n}"`)}</div>`).join('') || '<div class="empty-state"><p>没有尚未执行的输入</p></div>';
 }else if(m.type==='required-plugin'){
  title='当前组合需要这项基础能力';body='<p>当前工作台依赖这项能力。请先选择替代实现，再更改组合。</p><div class="notice">这次操作不会停止运行，也不会删除已有记录。</div>';footer=button('保留启用','close-modal','primary');
 }else if(m.type==='choose-session'){
  title='切换会话';body=state.sessions.map(sessionItem).join('');
 }else if(m.type==='file' || m.type==='attach'){
  title=m.type==='attach'?'添加工作区资料':'资料预览';const file=fileData().find(f=>f.id===m.id)||fileData()[0]||{name:'示例资料.md'};body=m.type==='attach'?fileData().map(f=>`<button class="file-row" data-action="attach-file" data-name="${escape(f.name)}">${icon('file')}<span><strong>${f.name}</strong><small>${f.detail}</small></span>${icon('plus')}</button>`).join('') || '<div class="empty-state"><p>当前工作区没有资料</p>'+button('添加示例文件','demo-file','secondary')+'</div>':`<h3>${file.name}</h3><div class="preview-content">受访者谈到：同时使用多个 Agent 时，最难的是知道哪一个仍在工作，哪一个在等自己回复。<br><br>“我希望打开工作台就知道，下一步需要我做什么。”<br><br>这是用于评审文件预览与上下文添加的示例内容。</div>`;if(m.type==='file')footer=button('加入当前输入','attach-file','primary',`data-name="${escape(file.name)}"`);
 }else if(m.type==='profile' || m.type==='model'){
  title=m.type==='model'?'会话配置':m.agent+' Profile';m.draft ||= {model:m.type==='model'?current().model:state.profiles[m.agent]};body=`<p class="page-lead">${m.agent || current().agent} · 示例能力</p><label class="form-label" for="model-choice">模型 / 模式</label><select id="model-choice" class="form-select" data-modal-field="model">${['Sonnet · 示例','默认配置 · 示例','快速响应 · 示例','深入分析 · 示例'].map(choice=>`<option ${m.draft.model===choice?'selected':''}>${choice}</option>`).join('')}</select><div class="notice">真实选项将来自 Agent 的协商能力。原型不会读取、保存或提交凭据。</div>`;footer=button('完成','save-model','primary');
 }else if(m.type==='plugin-blocked'){
  const p=state.plugins.find(p=>p.id===m.id);title='这项能力仍在使用中';body=`<p>“${escape(p.name)}”正被当前运行使用。停用前需要结束受影响的运行。</p><div class="notice">已有会话记录和产物保留；待处理请求会失效。</div>`;footer=button('保持启用','close-modal','secondary')+button('结束相关运行并停用','confirm-disable-plugin','danger',`data-id="${p.id}"`);
 }else if(m.type==='account'){
  title='我的工作台';body='<div class="workspace-row"><span class="avatar">Y</span><div><strong>示例用户</strong><p class="muted">个人服务器 · 浏览器访问</p></div></div><p>你可以查看登录界面的交互示意，返回后会保留当前原型状态。</p>';footer=button('返回工作台','close-modal','secondary')+button('查看登录界面','logout','primary');
 }else if(m.type==='state'){
  title='当前原型状态';wide=true;body='<p class="form-help">用于评审状态变化。所有数据仅在本页内存中，刷新或重置即恢复示例。</p><pre class="state-dump">'+escape(JSON.stringify(snapshot(),null,2))+'</pre>';
 }else if(m.type==='scenarios'){
  title='模拟一个关键状态';body=`<p class="form-help">这些是原型演示控制，不是正式产品功能。作用于当前会话。</p><div class="scenario-grid">${button(icon('shield')+' 权限请求','scenario-permission','secondary')}${button(icon('chat')+' 结构化输入','scenario-form','secondary')}${button(icon('info')+' 连接中断','scenario-interrupt','secondary')}${button(icon('clock')+' 交付不确定','scenario-unknown','secondary')}${button(icon('close')+' 旧请求失效','scenario-expire','secondary')}${button(icon('check')+' 完成当前执行','scenario-finish','secondary')}</div>`;
 }else if(m.type==='guide'){
  title='用一次真实工作来试用';body='<ol class="walkthrough-steps"><li><strong>先找到需要你处理的请求</strong><p>打开“待处理”，允许一次读取，或回答一个结构化问题。</p></li><li><strong>继续会话</strong><p>发送一条消息；执行时再发送一条，观察队列。比较“停止本轮”和“结束运行”。</p></li><li><strong>把结果接着用起来</strong><p>打开产物，加入输入，或在会话菜单中关联新 Agent。</p></li><li><strong>比较三种布局</strong><p>底部 A / B / C 切换，数据不变。用“模拟状态”试中断和失效请求。</p></li></ol><div class="notice">待确认：导航是否顺手、待处理与未读是否清楚、执行状态与工作区占用是否容易理解。</div>';
 }
 $('#overlays').innerHTML=`<div class="modal-backdrop"><section class="modal ${wide?'wide':''}" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><header class="modal-header"><h2 id="dialog-title">${title}</h2>${iconButton('close','关闭对话框','close-modal')}</header><div class="modal-body">${body}</div>${footer?`<footer class="modal-footer">${footer}</footer>`:''}</section></div>`;
}
function changeVariant(v){state.variant=v;state.inspector=v==='A' && window.innerWidth>=1100;const url=new URL(location.href);url.searchParams.set('variant',v);history.replaceState(null,'',url);record('切换布局',variants[v]);console.info('Aork prototype state',snapshot());render();}
function restore(s){
 if(alive(s)){state.modal=null;render();toast('当前运行仍在，无需恢复；可以继续对话或先结束运行');return;}
 const conflict=conflictingRun(s.workspace,s.id);
 if(conflict){toast('工作区仍由“'+conflict.title+'”占用。请结束该运行，或关联独立工作区的新会话。');state.modal=null;render();return;}
 cancelTimer(s.id);invalidate(s,'expired');s.generation++;s.run='ready';s.turn='idle';s.paused=true;s.messages.push({role:'system',text:'示例会话已恢复。原生历史保留，旧请求失效；排队输入需明确继续。'});state.modal=null;record('模拟恢复会话',s.title);render();
}
function handleAction(action,el){
 const s=current(),id=el.dataset.id;
 switch(action){
 case 'view':state.view=el.dataset.view;state.mobileNav=false;state.modal=null;render();break;
 case 'project':{state.project=id;const next=state.sessions.find(x=>x.project===id);if(next)switchSession(next.id);else {state.view='projects';render();}break;}
 case 'session':state.modal=null;switchSession(id);break;
 case 'new-session':openModal('new-session');break;
 case 'new-project':openModal('new-project');break;
 case 'new-workspace':openModal('new-workspace',{project:el.dataset.project});break;
 case 'choose-agent':state.modal.draft.agent=el.dataset.agent;render();break;
 case 'choose-session':openModal('choose-session');break;
 case 'close-modal':closeModal();break;
 case 'mobile-nav':state.mobileNav=!state.mobileNav;render();break;
 case 'toggle-inspector':state.inspector=!state.inspector;render();break;
 case 'tab':state.tab=el.dataset.tab;state.preview=null;render();break;
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
 case 'artifact':state.inspector=true;state.tab='artifacts';state.preview=id;state.view='work';render();break;
 case 'close-preview':state.preview=null;render();break;
 case 'file':openModal('file',{id});break;
 case 'demo-file':workspace(s.workspace).demoFiles=[{id:'demo-'+s.workspace,name:'示例资料.md',detail:'用于交互评审 · 示例'}];state.modal=null;render();toast('已加入内存示例文件，未读取真实文件');break;
 case 'attach':openModal('attach');break;
 case 'attach-file':state.attachments[s.id]||=[];if(!state.attachments[s.id].includes(el.dataset.name))state.attachments[s.id].push(el.dataset.name);state.modal=null;render();$('#composer')?.focus();toast('已加入下一条输入');break;
 case 'remove-attachment':state.attachments[s.id].splice(Number(el.dataset.index),1);render();break;
 case 'reuse-artifact':{const a=state.artifacts.find(a=>a.id===id);state.attachments[s.id]||=[];if(!state.attachments[s.id].includes(a.name+' · '+a.version))state.attachments[s.id].push(a.name+' · '+a.version);if(state.variant!=='A' || window.innerWidth<1100)state.inspector=false;render();$('#composer')?.focus();toast('已选中固定产物版本');break;}
 case 'download':{const a=state.artifacts.find(x=>x.id===id);const url=URL.createObjectURL(new Blob([a.content],{type:'text/markdown;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download=a.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('已下载示例产物');break;}
 case 'profile':openModal('profile',{agent:el.dataset.agent});break;
 case 'model':openModal('model');break;
 case 'save-model':if(state.modal.type==='model')s.model=$('#model-choice').value;else state.profiles[state.modal.agent]=$('#model-choice').value;state.modal=null;render();toast('示例配置已更新，已有会话保持自己的选择');break;
 case 'toggle-plugin':{const p=state.plugins.find(x=>x.id===id);if(p.required && p.enabled){openModal('required-plugin',{id});break;}if(p.enabled && state.sessions.some(alive)){openModal('plugin-blocked',{id});break;}p.enabled=!p.enabled;render();toast('示例插件状态已更新');break;}
 case 'confirm-disable-plugin':{const p=state.plugins.find(x=>x.id===id);if(p.required){toast('当前默认组合依赖该基础能力，请保留启用');closeModal();break;}state.sessions.filter(alive).forEach(endRun);p.enabled=false;state.modal=null;render();toast('已结束相关运行并停用，已有记录保留');break;}
 case 'account':openModal('account');break;
 case 'logout':state.signedIn=false;state.modal=null;render();break;
 case 'login':state.signedIn=true;state.view='work';render();break;
 case 'variant':changeVariant(el.dataset.variant);break;
 case 'previous-variant':case 'next-variant':{const keys=Object.keys(variants),n=keys.indexOf(state.variant);changeVariant(keys[(n+(action==='next-variant'?1:2))%3]);break;}
 case 'guide':case 'scenarios':case 'state':openModal(action);break;
 case 'scenario-permission':addRequest('permission');break;
 case 'scenario-form':addRequest('form');break;
 case 'scenario-interrupt':case 'scenario-unknown':cancelTimer(s.id);invalidate(s,'expired');s.run='terminated';s.turn=action==='scenario-unknown'?'delivery_unknown':'interrupted';s.paused=true;s.messages.push({role:'system',text:action==='scenario-unknown'?'发送窗口中断，交付结果无法确定，不会自动重发。':'示例连接中断，当前执行停止，排队输入保持暂停。'});state.modal=null;record('模拟中断',s.turn);render();break;
 case 'scenario-expire':invalidate(s,'expired');s.turn='interrupted';s.run='terminated';s.paused=true;cancelTimer(s.id);state.modal=null;record('旧请求失效',s.title);render();break;
 case 'scenario-finish':invalidate(s,'cancelled');s.turn='running';s.run='ready';state.modal=null;finishMock(s);break;
 case 'reset':{const v=state.variant;timers.forEach(clearTimeout);timers.clear();state={...seed(),variant:v,view:'work',project:'p1',session:'s1',inspector:v==='A' && window.innerWidth>=1100,tab:'files',preview:null,modal:null,mobileNav:false,drafts:{},attachments:{},events:[],counter:10,signedIn:true};render();toast('已重置全部示例状态');break;}
 }
}
document.addEventListener('click',event=>{const el=event.target.closest('[data-action]');if(el && !el.disabled)handleAction(el.dataset.action,el);else if(event.target.classList.contains('modal-backdrop'))closeModal();});
document.addEventListener('input',event=>{if(event.target.id==='composer')state.drafts[current().id]=event.target.value;if(event.target.dataset.modalField && state.modal?.draft)state.modal.draft[event.target.dataset.modalField]=event.target.type==='checkbox'?event.target.checked:event.target.value;});
document.addEventListener('change',event=>{if(event.target.dataset.interactionDraft){const i=state.interactions.find(x=>x.id===event.target.dataset.interactionDraft);if(i)i.draftAnswer=event.target.value;}if(event.target.dataset.modalField && state.modal?.draft){state.modal.draft[event.target.dataset.modalField]=event.target.type==='checkbox'?event.target.checked:event.target.value;if(event.target.dataset.modalField==='project'){state.modal.draft.workspace='new';render();}}});
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
 }else if(form.dataset.form==='workspace'){
  const name=String(data.get('name')||'').trim(),path=String(data.get('path')||'').trim();if(!name || !path)return;
  let p=state.modal.project;if(state.modal.type==='new-project'){p='p'+(++state.counter);state.projects.push({id:p,name,kind:'通用',color:'sage'});}
  state.workspaces.push({id:'w'+(++state.counter),project:p,name,path});state.project=p;state.modal=null;state.view='projects';record('创建示例工作环境',name);render();toast('已登记示例工作区，未创建真实目录');
 }
});
document.addEventListener('keydown',event=>{
 if(state.modal){
  if(event.key==='Escape'){event.preventDefault();closeModal();return;}
  if(event.key==='Tab'){const controls=[...document.querySelectorAll('#overlays button, #overlays input, #overlays select, #overlays textarea, #overlays a[href]')].filter(el=>!el.disabled && el.offsetParent!==null);const first=controls[0],last=controls.at(-1);if(event.shiftKey && document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first?.focus();}}
  return;
 }
 if(event.target.id==='composer' && event.key==='Enter' && !event.shiftKey && !event.isComposing){event.preventDefault();event.target.form.requestSubmit();return;}
 if(event.target.closest('input,textarea,select,[contenteditable="true"]'))return;
 if(event.key==='ArrowLeft' || event.key==='ArrowRight'){event.preventDefault();handleAction(event.key==='ArrowRight'?'next-variant':'previous-variant',{dataset:{}});}
});
window.addEventListener('popstate',()=>{const v=new URLSearchParams(location.search).get('variant');if(variants[v]){state.variant=v;state.inspector=v==='A' && window.innerWidth>=1100;render();}});
let wasCompact=window.innerWidth<800;
window.addEventListener('resize',()=>{const compact=window.innerWidth<800;if(compact!==wasCompact){wasCompact=compact;if(compact)state.inspector=false;render();}});
render();console.info('Aork prototype state',snapshot());
})();
