/* Operational queue details. No credentials, private job names or raw Slurm output. */
(function (root) {
  'use strict';
  const reasons = {
    Priority: ['Scheduler priority', 'Higher-priority eligible tasks are ahead in the scheduler.'],
    Resources: ['Waiting for resources', 'The requested combination of GPUs, CPUs, memory and nodes is not available.'],
    Dependency: ['Waiting for another job', 'A required predecessor has not satisfied this task’s dependency.'],
    DependencyNeverSatisfied: ['Dependency cannot be satisfied', 'A predecessor failed or the dependency can no longer be met. The task owner must review it.'],
    JobHeldUser: ['Held by user', 'The task is on a user hold. It cannot start until the owner releases the hold.'],
    JobHeldAdmin: ['Held by administrator', 'The scheduler administrator has placed this task on hold.'],
    BeginTime: ['Scheduled for later', 'The requested earliest start time has not arrived.'],
    ReqNodeNotAvail: ['Required node unavailable', 'A requested node is unavailable, reserved, down or drained.'],
    Reservation: ['Waiting for reservation', 'The task is waiting for its applicable reservation.'],
    MaxGRESPerAccount: ['Account GPU limit', 'The lab’s GPU allocation limit prevents the task from starting.'],
    QOSMaxGRESPerUser: ['User GPU limit', 'A per-user GPU limit is currently reached.'],
    QOSMaxGRESPerAccount: ['Account GPU limit', 'A per-account GPU limit is currently reached.'],
    QOSGrpGRES: ['Shared GPU limit', 'A shared quality-of-service GPU limit is currently reached.'],
    AssocGrpGRES: ['Account resource limit', 'An association-wide resource limit is currently reached.'],
    AssocMaxJobsLimit: ['Account job limit', 'The account has reached its concurrent job limit.'],
    QOSMaxJobsPerUserLimit: ['User job limit', 'The user has reached the concurrent job limit.'],
    JobArrayTaskLimit: ['Array concurrency limit', 'This job array already has its allowed number of tasks running.'],
  };
  const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
  const duration = seconds => {
    if (!Number.isFinite(seconds)) return 'Not available';
    if (seconds < 60) return '<1m';
    const m = Math.floor(Math.max(0, seconds) / 60), d = Math.floor(m / 1440), h = Math.floor(m % 1440 / 60);
    return d ? `${d}d ${h}h ${m % 60}m` : h ? `${h}h ${m % 60}m` : `${m}m`;
  };
  const date = value => stamp(value) === null ? 'Not available' : new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
  }).format(new Date(value));
  const secondsBetween = (a, b) => a === null || b === null || b < a ? null : (b - a) / 1000;
  const wait = (job, anchor) => secondsBetween(stamp(job.submitted_at), job.state === 'running' ? stamp(job.started_at) : anchor);
  const median = list => { const a = list.filter(Number.isFinite).sort((x,y) => x-y); return a.length ? (a[Math.floor((a.length-1)/2)] + a[Math.floor(a.length/2)]) / 2 : null; };
  function forecast(job, anchor) {
    if (job.state !== 'pending') return {label: 'Already running', remaining: null, kind: 'running'};
    if (/^JobHeld/.test(job.reason || '')) return {label: 'On hold', remaining: null, kind: 'blocked'};
    if (/^Dependency/.test(job.reason || '')) return {label: 'Waiting for dependency', remaining: null, kind: 'blocked'};
    const start = stamp(job.estimated_start_at);
    if (start === null || anchor === null) return {label: 'No Slurm estimate', remaining: null, kind: 'unknown'};
    if (start <= anchor) return {label: 'Estimate outdated', remaining: null, kind: 'outdated'};
    return {label: date(job.estimated_start_at), remaining: (start-anchor)/1000, kind: 'estimate'};
  }
  function summarize(jobs, anchor) {
    const grouped = new Map();
    jobs.forEach(job => { if (!grouped.has(job.username)) grouped.set(job.username, []); grouped.get(job.username).push(job); });
    return [...grouped].map(([username, rows]) => {
      const pending = rows.filter(j => j.state === 'pending');
      const waits = pending.map(j => wait(j, anchor)).filter(Number.isFinite);
      const estimates = pending.filter(j => forecast(j,anchor).kind === 'estimate').sort((a,b) => stamp(a.estimated_start_at)-stamp(b.estimated_start_at));
      const reasonCounts = new Map(); pending.forEach(j => reasonCounts.set(j.reason || 'Unknown', (reasonCounts.get(j.reason || 'Unknown') || 0)+1));
      return { username, total: rows.length, running: rows.length-pending.length, pending: pending.length,
        median: median(waits), longest: waits.length ? Math.max(...waits) : null, next: estimates[0] || null,
        estimated: estimates.length, reasons: [...reasonCounts].sort((a,b) => b[1]-a[1]) };
    }).sort((a,b) => b.pending-a.pending || a.username.localeCompare(b.username));
  }
  const api = { stamp, duration, date, wait, median, forecast, summarize };
  if (typeof module !== 'undefined') module.exports = api;
  if (!root.document) return;
  const el = id => document.getElementById(id);
  const make = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
  const cell = (text, sub) => { const n = make('td', text); if (sub) n.append(make('small',sub)); return n; };
  let jobs = null, payload = null, anchor = null, sourceTime = null;
  function empty(body, columns, text) { body.replaceChildren(); const tr=make('tr'),td=make('td',text,'lab-empty');td.colSpan=columns;tr.append(td);body.append(tr); }
  function options(id, values, label) {
    const select = el(id), selected = select.value;
    select.replaceChildren(new Option(label, 'all'));
    values.forEach(v => select.add(new Option(v, v)));
    select.value = values.includes(selected) ? selected : 'all';
  }
  function renderTables() {
    const usersBody = el('lab-users-body'), tasksBody = el('lab-tasks-body');
    if (!Array.isArray(jobs)) {
      el('lab-jobs-summary').textContent = 'The current feed has not supplied per-task queue details yet. Aggregate counts above remain available.';
      empty(usersBody,8,'User-level queue data is not available in this snapshot.');
      empty(tasksBody,8,'Waiting for the detailed telemetry feed.');
      el('lab-visible-count').textContent = ''; return;
    }
    const summaries=summarize(jobs,anchor), pending=jobs.filter(j=>j.state==='pending').length;
    el('lab-jobs-summary').textContent=`${summaries.length} users · ${jobs.length} active tasks · ${pending} pending · ${jobs.length-pending} running. Captured ${date(sourceTime)}. Click a username to inspect their tasks.`;
    usersBody.replaceChildren();
    if (!summaries.length) empty(usersBody,8,'No active tasks in this lab account.');
    summaries.forEach(u => {
      const tr=make('tr'), username=cell(''), button=make('button',u.username,'lab-user-button');button.type='button';
      button.addEventListener('click',()=>{el('lab-user-filter').value=u.username;el('lab-state-filter').value='all';el('lab-reason-filter').value='all';renderTables();el('lab-user-filter').focus();});username.append(button);
      tr.append(username,cell(String(u.total)),cell(String(u.running)),cell(String(u.pending)),cell(u.pending?duration(u.median):'—'),cell(u.pending?duration(u.longest):'—'),
        cell(u.next?date(u.next.estimated_start_at):u.pending?'No Slurm estimate':'—',u.pending?`${u.estimated} of ${u.pending} pending tasks have a usable estimate`:null),
        cell(u.reasons.map(([r,n])=>`${r} × ${n}`).join(' · ') || '—'));
      usersBody.append(tr);
    });
    const visible=jobs.map((j,i)=>({...j,_row:i+1})).filter(j=>(el('lab-user-filter').value==='all'||j.username===el('lab-user-filter').value)&&(el('lab-state-filter').value==='all'||j.state===el('lab-state-filter').value)&&(el('lab-reason-filter').value==='all'||j.reason===el('lab-reason-filter').value));
    visible.sort((a,b)=>Number(b.state==='pending')-Number(a.state==='pending')||(wait(b,anchor)??-1)-(wait(a,anchor)??-1)||a.username.localeCompare(b.username));
    el('lab-visible-count').textContent=`${visible.length} of ${jobs.length} tasks`;
    tasksBody.replaceChildren();if(!visible.length)empty(tasksBody,8,'No tasks match these filters.');
    visible.forEach(job=>{
      const tr=make('tr'),badge=make('span',job.state==='pending'?'Pending':'Running','lab-state');badge.dataset.state=job.state;badge.dataset.held=String(/^JobHeld/.test(job.reason||''));const state=cell('');state.append(badge);
      const f=forecast(job,anchor),reason=reasons[job.reason],isPending=job.state==='pending';
      const eligible=secondsBetween(stamp(job.eligible_at),anchor);
      tr.append(cell(job.username,`Task ${job._row} in this snapshot`),state,cell(job.partition,`${job.cpu_cores} CPU cores · ${job.gpu_units} GPU units`),cell(date(job.submitted_at)),
        cell(duration(wait(job,anchor)),isPending?'Eligible wait: '+duration(eligible):'Before actual start'),
        cell(isPending?(job.reason||'Unknown'):'—',isPending?(reason?reason[1]:'Slurm reported this reason; no further explanation is available in the snapshot.'):null),
        cell(isPending?f.label:date(job.started_at),isPending&&f.kind==='estimate'?'Remaining: '+duration(f.remaining)+(job.estimate_scope==='array_group'?' (array-group estimate)':' · Slurm prediction'):isPending?null:'Actual start'),
        cell(isPending?'—':duration(secondsBetween(stamp(job.started_at),anchor))));tasksBody.append(tr);
    });
  }
  function freshness() {
    const validUntil=stamp(payload?.freshness?.valid_until), stale=anchor!==null&&(validUntil!==null?Date.now()>validUntil:Date.now()-anchor>240000);
    el('lab-feed-status').dataset.stale=String(stale||!Array.isArray(jobs));
    el('lab-feed-status').textContent=!Array.isArray(jobs)?'Task feed unavailable':stale?'Stale snapshot · times frozen':'Live · refreshes every 2 minutes';
  }
  api.render=(data,observedAt)=>{
    payload=data;sourceTime=observedAt||data?.freshness?.generated_at;anchor=stamp(sourceTime);
    jobs=data?.privacy==='lab_authorized_operational'&&data?.schema_version==='monitor.public.v3'&&Array.isArray(data.user_jobs)?data.user_jobs:null;
    options('lab-user-filter',[...new Set((jobs||[]).map(j=>j.username))].sort(),'All users');
    options('lab-reason-filter',[...new Set((jobs||[]).filter(j=>j.state==='pending').map(j=>j.reason||'Unknown'))].sort(),'All reasons');
    renderTables();freshness();
  };
  root.BettyQueue=api;
  ['lab-user-filter','lab-state-filter','lab-reason-filter'].forEach(id=>el(id).addEventListener('change',renderTables));
  el('lab-reset-filters').addEventListener('click',()=>{['lab-user-filter','lab-state-filter','lab-reason-filter'].forEach(id=>el(id).value='all');renderTables();});
  setInterval(freshness,30000);
})(typeof window === 'undefined' ? globalThis : window);
