import { useEffect, useRef, useState } from 'react';
import type { UiRuntime } from '@aork/sdk/client';
import { SESSION_RECONCILIATION, reconciliationSnapshotSchema, type Reconciliation } from '@aork/contracts/reconciliation';
import styles from './sessions.module.css';
const reasons: Record<Reconciliation['reason'], string> = {
  'managed-stop-confirmed':'已确认受管执行结束。', 'never-started':'已确认尚未启动任何受管写入。', 'covered-group-absent':'完整覆盖的受管进程组已消失。',
  'group-present':'记录的进程组仍存在；无法验证它当前的身份或归属。', 'identity-missing':'启动尝试没有留下可核对的进程组身份，自动解除不可用。',
  'inspection-unavailable':'本机进程组观察不可用，无法确认停止。', 'coverage-incomplete':'旧记录缺少完整写入范围，自动解除不可用。',
  'participant-unavailable':'所需写入管理能力不可用，无法确认停止。', 'work-unsettled':'登记的受管工作尚未确认全部结束。', 'authority-unavailable':'运行核对能力不可用，工作区继续保持保护。',
};
export function ReconciliationPanel({runtime,runId,state}:{runtime:UiRuntime;runId:string;state:string}) {
  const [diagnostic,setDiagnostic]=useState<Reconciliation|null>();const [readError,setReadError]=useState('');const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  const storageKey=`aork.recheck:${runtime.bootstrap.access.identity}:${runId}`;
  const pending=useRef<string|undefined>(undefined);const [retry,setRetry]=useState(false);
  useEffect(()=>{try{pending.current=sessionStorage.getItem(storageKey)??undefined;setRetry(Boolean(pending.current));}catch{/* The mounted view retains its original command ID. */}},[storageKey]);
  useEffect(()=>{let active=true;const stop=runtime.observeSnapshot(SESSION_RECONCILIATION,{runId},{next(value){const parsed=reconciliationSnapshotSchema.parse(value);if(active){setDiagnostic(parsed.reconciliation);setReadError('');}},error(failure){if(active)setReadError(failure.message);}},{owners:['sessions']});return()=>{active=false;void stop();};},[runtime,runId]);
  async function recheck(){if(busy)return;const id=pending.current??crypto.randomUUID();pending.current=id;try{sessionStorage.setItem(storageKey,id);}catch{}setBusy(true);setError('');setRetry(true);
    try{await runtime.command('sessions.recheckRun',{runId},id,{version:1});pending.current=undefined;try{sessionStorage.removeItem(storageKey);}catch{}setRetry(false);}
    catch(failure){setError(failure instanceof Error?failure.message:'核对回执暂不可用，可使用原命令重试。');}finally{setBusy(false);}
  }
  if(state!=='unknown'&&!diagnostic&&!readError)return null;
  return <section className={styles.reconciliation} aria-label="中断核对">
    <h3>中断核对</h3>
    {diagnostic?.status==='verified-stopped'?<p role="status">已核实受管写入停止；队列仍保持暂停。</p>:state==='stopped'?<p>运行已结束；核对详情暂不可用。</p>:<>
      <p>工作区保持保护；已保存的内容仍可查看。</p>
      <p>{diagnostic?reasons[diagnostic.reason]:'正在读取核对信息…'}</p>
      <p>旧 Agent 连接无法复用。请通过实际本地进程或工具的管理入口检查并结束旧工作，然后再次核对。</p>
      {diagnostic?.actions.includes('restore-authority')&&<p>需要本地维护恢复或验证缺失的管理能力；仅等待或重试不能补足停止证明。</p>}
    </>}
    {readError&&<p role="alert">核对信息读取失败；已保存历史仍保留。{readError}</p>}
    {error&&<p role="alert">{error}</p>}
    {(state==='unknown'||retry)&&<button disabled={busy} onClick={()=>void recheck()}>{busy?'正在核对…':retry?'重试核对回执':'再次核对'}</button>}
    <p className={styles.hint}>核对与浏览器重连不会重发输入或继续队列。其他独立工作区仍可使用。</p>
  </section>;
}
