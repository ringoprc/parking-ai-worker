const $ = (s) => document.querySelector(s);
let latest = null;
let paused = false;
let failureSignature = null;
let deviceIssueSignature = null;
let watchlistTab = "healthy";
let watchlistQuery = "";
const stages = ["download", "prepare", "vlm", "submit", "complete"];
const labels = { starting:"Starting services", polling:"Checking for new images", idle:"Standing by for new images", processing:"Reading parking availability", processed:"Result delivered", error:"Worker needs attention" };
const statusLabels = { running:"進行中", completed:"完成" };
const esc = (v="") => String(v).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const age = (iso) => { if(!iso)return "—"; const s=Math.max(0,Math.floor((Date.now()-new Date(iso))/1000)); return s<60?`${s}s ago`:s<3600?`${Math.floor(s/60)}m ago`:`${Math.floor(s/3600)}h ago`; };
const duration = (job) => `${((new Date(job.completedAt || Date.now())-new Date(job.startedAt))/1000).toFixed(1)}s`;
const longDuration = (ms) => { if(!Number.isFinite(ms)||ms<0)return "—"; const s=Math.floor(ms/1000); if(s<60)return `${s}s`; if(s<3600)return `${Math.floor(s/60)}m ${s%60}s`; if(s<86400)return `${Math.floor(s/3600)}h ${Math.floor(s%3600/60)}m`; return `${Math.floor(s/86400)}d ${Math.floor(s%86400/3600)}h`; };
function renderFailures(failures){
  const signature=JSON.stringify(failures);
  $("#failureMeta").textContent=`${failures.length} retained`;
  if(signature===failureSignature)return;
  const firstRender=failureSignature===null;
  const openIds=new Set([...document.querySelectorAll("#failures details[open]")].map(item=>item.dataset.failureId));
  $("#failures").innerHTML=failures.length?failures.map((f,i)=>`<details class="failure" data-failure-id="${esc(f.id)}" ${(firstRender&&i===0)||openIds.has(String(f.id))?"open":""}><summary><span class="failure-icon">!</span><span class="failure-title"><b>${esc(f.deviceId)}</b><small>${esc(f.context)} · ${esc(f.failedStage)} stage</small></span><time>${age(f.failedAt)}</time><span class="chevron">⌄</span></summary><div class="failure-body"><div><p class="failure-label">WHAT HAPPENED</p><code>${esc(f.error)}</code></div><div class="hint"><p class="failure-label">LIKELY NEXT STEP</p><p>${esc(f.hint)}</p></div>${f.imageObject?`<div class="failure-object"><p class="failure-label">IMAGE OBJECT</p><span class="mono">${esc(f.imageObject)}</span></div>`:""}</div></details>`).join(""):`<div class="empty compact">No failures recorded since this worker started.</div>`;
  failureSignature=signature;
}
function renderDeviceIssues(devices){
  const searching=watchlistQuery.trim().length>0;
  const filtered=devices.filter(device=>searching?fuzzyMatch(watchlistQuery,device.deviceId,device.parkingLotName):watchlistTab==="healthy"?device.successfulCount>device.problematicCount:device.problematicCount>=device.successfulCount);
  const signature=`${watchlistTab}:${watchlistQuery}:${JSON.stringify(filtered)}`;
  $("#watchlistTabs").hidden=searching;
  $("#watchlistMeta").textContent=`${filtered.length} 台裝置`;
  if(signature===deviceIssueSignature)return;
  $("#deviceIssues").innerHTML=filtered.length?filtered.map((device,index)=>{const deviceLabel=device.parkingLotName||device.deviceId;return `<article class="device-issue"><span class="issue-rank">${String(index+1).padStart(2,"0")}</span><div class="issue-device" title="Device: ${esc(device.deviceId)}"><div class="issue-top"><b>${esc(deviceLabel)}</b><div class="issue-counts"><span class="success-count"><strong>${device.successfulCount}</strong> 成功</span>${device.nullVacancyCount?`<span><strong>${device.nullVacancyCount}</strong> 無法辨識</span>`:""}${device.failedCount?`<span><strong>${device.failedCount}</strong> 失敗</span>`:""}</div></div><div class="issue-bottom">${renderResultHistory(device.resultHistory,10,true)}<time>${age(device.lastResultAt)}</time></div></div></article>`}).join(""):`<div class="empty">${searching?"找不到符合的裝置。":watchlistTab==="healthy"?"目前沒有成功結果較多的裝置。":"目前沒有需要注意的裝置。"}</div>`;
  deviceIssueSignature=signature;
}
function fuzzyMatch(query,...values){
  const q=query.trim().toLocaleLowerCase();
  if(!q)return true;
  return values.filter(Boolean).some(value=>{const text=String(value).toLocaleLowerCase();if(text.includes(q))return true;let index=0;for(const char of text)if(char===q[index])index+=1;return index===q.length});
}
function renderResultHistory(results,limit=5,compact=false){
  const history=[...(results||[])].reverse().slice(-limit);
  if(!history.length)return `<small class="history-empty">還沒有辨識結果</small>`;
  if(compact)return `<div class="result-history watchlist-result-history">${history.map((item,index)=>{const isError=item.kind==="error";const value=isError?"!":item.vacancy===null?"X":esc(item.vacancy);const itemClass=isError?"history-error":item.vacancy===null?"history-null":"";return `<span class="watchlist-history-step"><span class="history-slot ${itemClass}" title="${isError?"Failed attempt · ":""}${esc(item.at)}">${value}</span>${index<history.length-1?`<i class="history-arrow" aria-hidden="true">&gt;</i>`:""}</span>`}).join("")}</div>`;
  const slots=[...history.map(result=>({result})),...Array(limit-history.length).fill(null)];
  return `<div class="result-history">${slots.map((slot,index)=>{
    const nextIsPopulated=index<limit-1&&slots[index+1]!==null;
    const arrow=index<limit-1?`<i class="history-arrow" aria-hidden="true">${slot&&nextIsPopulated?"&gt;":""}</i>`:"";
    if(!slot)return `<span class="history-slot history-slot-empty" aria-hidden="true"></span>${arrow}`;
    const item=slot.result;
    const isError=item.kind==="error";
    const value=isError?"!":item.vacancy===null?"X":esc(item.vacancy);
    const itemClass=isError?"history-error":item.vacancy===null?"history-null":"";
    return `<span class="history-slot ${itemClass}" title="${isError?"Failed attempt · ":""}${esc(item.at)}">${value}</span>${arrow}`;
  }).join("")}</div>`;
}
function render(s){ latest=s; const active=s.jobs.filter(j=>j.status==="running"); $("#activeCount").textContent=active.length; $("#completedCurrent").textContent=s.totals.completed; $("#completedTotal").textContent=`/${s.totals.discovered}`; $("#heroTitle").textContent=labels[s.status] || "Worker is online"; $("#heroCopy").textContent=active.length?`${active.length} job${active.length===1?" is":"s are"} moving through the processing floor.`:`Last poll ${age(s.lastPollAt)} · uptime ${age(s.startedAt).replace(" ago","")}`;
  const uptime=Math.floor((Date.now()-new Date(s.startedAt))/1000); const settled=s.totals.completed+s.totals.failed; const failureRate=settled?s.totals.failed/settled*100:0; const recognized=Number(s.totals.recognized)||0; const recognitionRate=s.totals.completed?recognized/s.totals.completed*100:0; const averageMs=s.totals.completed?s.totals.totalProcessingMs/s.totals.completed:0; const perMinute=(s.completionTimes||[]).filter(at=>Date.now()-new Date(at).getTime()<60000).length;
  const averageLabel=!averageMs?"—":averageMs<1000?`${Math.round(averageMs)}ms`:`${(averageMs/1000).toFixed(1)}s`;
  const fleet=s.fleetStats||{}; const delaySince=Date.parse(fleet.longestAiDelaySince); const measuredAt=Date.parse(fleet.measuredAt); const suppliedDelay=typeof fleet.longestAiDelayMs==="number"?fleet.longestAiDelayMs:NaN; const fleetDelay=Number.isFinite(delaySince)?Date.now()-delaySince:Number.isFinite(suppliedDelay)?suppliedDelay+(Number.isFinite(measuredAt)?Date.now()-measuredAt:0):NaN; const delayTitle=fleet.longestAiDelayDeviceId?`Device ${fleet.longestAiDelayDeviceId}${fleet.longestAiDelayBasis==="never_processed"?" · never processed":""}`:"Waiting for backend fleet statistics";
  const metrics=[[perMinute,"平均每分鐘辨識張數","live"],[averageLabel,"平均每張圖片處理時間"],[longDuration(fleetDelay),"Longest AI delay",Number.isFinite(fleetDelay)?"attention":"",delayTitle],[`${recognitionRate.toFixed(1)}%`,"成功辨識出數字比例","recognition",`${recognized} integer vacancies accepted across ${s.totals.completed} completed tasks`],[`${failureRate.toFixed(1)}%`,"未完成後台數字回報比例",failureRate>0?"danger":"","",s.totals.failed],[uptime<3600?`${Math.floor(uptime/60)}m ${uptime%60}s`:`${Math.floor(uptime/3600)}h ${Math.floor(uptime%3600/60)}m`,"本次已運行時間"]];
  $("#metrics").innerHTML=metrics.map(([v,l,c="",title="",failedCount=null])=>`<div class="metric ${c}" title="${esc(title)}"><b>${v}</b><div class="metric-caption"><span>${l}</span>${failedCount!==null?`<em><strong>${failedCount}</strong> failed</em>`:""}</div></div>`).join(""); $("#pipelineMeta").textContent=`${active.length} active · ${s.jobs.length} retained`; $("#workerId").textContent=s.workerId;
  $("#jobs").innerHTML=s.jobs.length?s.jobs.map(job=>{const n=job.status==="failed"?stages.length:Math.max(0,stages.indexOf(job.stage));const acceptedResult=job.status==="failed"?`<span class="vacancy-value vacancy-error" title="Processing failed">!</span>`:job.status==="completed"?(job.vacancy===null?`<span class="vacancy-value vacancy-missing" title="Server accepted a null vacancy">X</span>`:job.vacancy!==undefined?`<span class="vacancy-value" title="Server accepted vacancy">${esc(job.vacancy)}</span>`:""):"";const historyMarkup=renderResultHistory(job.deviceResultHistory);const jobLabel=job.parkingLotName||job.deviceId;return `<article class="job"><div class="job-id" title="Device: ${esc(job.deviceId)} · Image: ${esc(job.imageObject)}"><b>${esc(jobLabel)}</b>${historyMarkup}</div><div class="track">${stages.map((x,i)=>`<i class="${job.status==="completed"&&job.vacancy===null&&i===stages.length-1?"null-result":job.status==="failed"&&i===n-1?"failed":i<n||job.status==="completed"?"done":i===n?"current":""}" title="${x}"></i>`).join("")}</div><div class="duration">${acceptedResult}<span class="job-state"><strong>${esc(statusLabels[job.status]||job.status)}</strong><small>${duration(job)}</small></span></div></article>`}).join(""):`<div class="empty">The floor is quiet. New work will appear here automatically.</div>`;
  renderDeviceIssues(s.deviceWatchlist||[]);
  if(!paused) $("#events").innerHTML=s.events.length?s.events.map(e=>`<article class="event ${esc(e.type)}"><span class="event-dot"></span><p>${esc(e.message)}</p><time>${age(e.at)}</time></article>`).join(""):`<div class="empty">Listening for worker activity…</div>`;
  renderFailures(s.failures||[]);
  const names={pollIntervalMs:"Poll interval",concurrency:"Job concurrency",batchSize:"Batch size",prepareConcurrency:"Image prep",vlmConcurrency:"VLM slots",submitConcurrency:"Submit slots"}; $("#config").innerHTML=Object.entries(names).map(([k,l])=>`<div class="config-item"><span>${l}</span><b>${s.config[k]??"—"}${k==="pollIntervalMs"?" ms":""}</b></div>`).join("");
}
function connect(){const es=new EventSource("/api/events");es.onopen=()=>{$("#connectionDot").classList.add("live");$("#connectionLabel").textContent="Live"};es.onmessage=e=>render(JSON.parse(e.data));es.onerror=()=>{$("#connectionDot").classList.remove("live");$("#connectionLabel").textContent="Reconnecting"};}
$("#pauseButton").onclick=()=>{paused=!paused;$("#pauseButton").textContent=paused?"Resume":"Pause";if(!paused&&latest)render(latest)}; setInterval(()=>{$("#clock").textContent=new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"});if(latest)render(latest)},1000); connect();
document.querySelectorAll("[data-watchlist-tab]").forEach(button=>button.addEventListener("click",()=>{watchlistTab=button.dataset.watchlistTab;document.querySelectorAll("[data-watchlist-tab]").forEach(tab=>{const active=tab===button;tab.classList.toggle("active",active);tab.setAttribute("aria-selected",String(active))});deviceIssueSignature=null;if(latest)renderDeviceIssues(latest.deviceWatchlist||[])}));
$("#watchlistSearch").addEventListener("input",event=>{watchlistQuery=event.target.value;deviceIssueSignature=null;if(latest)renderDeviceIssues(latest.deviceWatchlist||[])});
