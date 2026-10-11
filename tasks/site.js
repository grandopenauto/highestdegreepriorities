(function(){
"use strict";
const tasks=Array.isArray(window.HDP_TASKS)?window.HDP_TASKS:[];
const packages=Array.isArray(window.HDP_PACKAGES)?window.HDP_PACKAGES:[];
const byId=new Map(tasks.map(t=>[t.id,t]));
const search=document.getElementById("taskSearch");
const grid=document.getElementById("taskGrid");
const count=document.getElementById("tasksCount");
const empty=document.getElementById("taskEmpty");
const context=document.getElementById("filterContext");
const dialog=document.getElementById("taskDetail");
const dialogBody=document.getElementById("taskDialogBody");
const params=new URLSearchParams(location.search);
const moduleFocus=(params.get("module")||"").slice(0,120);
let category="All";
const safe=v=>String(v??"").replace(/[&<>"']/g,x=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[x]));
function track(name,props){if(typeof window.hdpTrackEvent==="function")window.hdpTrackEvent(name,props||{});}
function external(t){const u=t.url||"";return u.startsWith("/")||u.startsWith("https://")?u:null;}
function linkAttrs(t){return t.url?.startsWith("https://")?' target="_blank" rel="noopener noreferrer"':'';}
function inquiry(t){
 const subject="HDP single task request: "+t.title;
 const body=[
 "Hello HDP,",
 "I would like to use or commission one focused HDP task.",
 "",
 "Task: "+t.title,
 "Outcome: "+t.result,
 "Suggested HDP capabilities: "+t.modules.join("; "),
 "",
 "My specific objective:",
 "",
 "Current software/provider:",
 "",
 "Timing and constraints:",
 "",
 "Please confirm availability, scope, cost, delivery method and any required approval. I understand that this does not activate a paid service."
 ].join("\n");
 return "mailto:contact@highestdegreepriorities.com?subject="+encodeURIComponent(subject)+"&body="+encodeURIComponent(body);
}
function taskLink(t){return "/tasks/?task="+encodeURIComponent(t.id);}
function openLink(t){
 const url=external(t);
 if(url)return '<a data-open-tool="'+safe(t.id)+'" href="'+safe(url)+'"'+linkAttrs(t)+'>'+safe(t.action)+" ↗</a>";
 return '<a data-request-task="'+safe(t.id)+'" href="'+safe(inquiry(t))+'">Request this task ↗</a>';
}
function related(t){
 return packages.map(p=>({p,score:p.includes.filter(m=>t.modules.includes(m)).length})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score||Number(Boolean(b.p.featured))-Number(Boolean(a.p.featured))).slice(0,5).map(x=>x.p);
}
function card(t){
 const publicLink=!!external(t);
 return '<article class="task-card">'+
 '<div class="task-top"><span class="task-icon" aria-hidden="true">↗</span><span class="task-status '+(publicLink?"public":"")+'">'+safe(t.access)+'</span></div>'+
 '<div class="small-tag">'+safe(t.category)+'</div>'+
 '<h3>'+safe(t.title)+'</h3><p>'+safe(t.summary)+'</p>'+
 '<span class="task-components">'+t.modules.length+' related HDP capabilities · '+related(t).length+' connected Business OS matches</span>'+
 '<div class="task-cta">'+openLink(t)+'<button type="button" data-open-detail="'+safe(t.id)+'">Details</button></div>'+
 '<a class="task-product-link" data-configure-task="'+safe(t.id)+'" href="/task/?task='+encodeURIComponent(t.id)+'">Configure task &amp; export JSON →</a>'+
 '</article>';
}
function refresh(){
 let q=(search.value||"").trim().toLowerCase();
 const only=document.getElementById("availableOnly").checked;
 const showing=tasks.filter(t=>(category==="All"||t.category===category) && (!moduleFocus||t.modules.includes(moduleFocus)) && (!only||!!external(t)) && (!q||[t.title,t.category,t.summary,t.result,...t.modules].join(" ").toLowerCase().includes(q)));
 grid.innerHTML=showing.map(card).join("");
 count.textContent=showing.length+" of "+tasks.length+" single-task options";
 empty.hidden=showing.length!==0;
 document.querySelectorAll("[data-category]").forEach(b=>b.setAttribute("aria-pressed",String(b.dataset.category===category)));
 if(moduleFocus){
  context.hidden=false;
  context.innerHTML="<strong>Tasks connected to "+safe(moduleFocus)+"</strong>Choose an individual outcome below, or <a href='/tasks/'>view every task</a>.";
 }else context.hidden=true;
}
function showTask(id,changeHistory){
 const t=byId.get(id);if(!t)return;
 const bos=related(t);
 dialogBody.innerHTML=
 '<div class="eyebrow">'+safe(t.category)+' · '+safe(t.access)+'</div>'+
 '<h2 id="taskDialogTitle">'+safe(t.title)+'</h2>'+
 '<p class="description">'+safe(t.summary)+'</p>'+
 '<div class="task-steps"><b>Expected outcome</b><p>'+safe(t.result)+'</p></div>'+
 '<h3>Related HDP building blocks</h3><ul>'+t.modules.map(m=>'<li><a class="task-link-inline" href="/tasks/?module='+encodeURIComponent(m)+'">'+safe(m)+'</a></li>').join("")+'</ul>'+
 '<h3>Business OS packages that use these capabilities</h3>'+
 (bos.length?'<div class="related-bos">'+bos.map(p=>'<a href="/business/?package='+encodeURIComponent(p.id)+'">'+safe(p.name)+' →</a>').join("")+'</div>':'<p>Ask HDP about a custom business package.</p>')+
 '<div class="dialog-actions">'+(external(t)?'<a class="btn navy" data-open-tool="'+safe(t.id)+'" href="'+safe(external(t))+'"'+linkAttrs(t)+'>'+safe(t.action)+' ↗</a>':'<a class="btn navy" data-request-task="'+safe(t.id)+'" href="'+safe(inquiry(t))+'">Request this single task ↗</a>')+
 '<a class="btn light-button" data-configure-task="'+safe(t.id)+'" href="/task/?task='+encodeURIComponent(t.id)+'">Configure task →</a>'+
 '<button class="btn light-button" type="button" data-copy-brief="'+safe(t.id)+'">Copy task brief</button></div>'+
 '<p class="task-legal">A public link points to an existing page, not proof of completed service or paid activation. Planned services require availability, scope, and price confirmation. No payment or provisioning happens here.</p>'+
 '<button class="share-link" type="button" data-share-task="'+safe(t.id)+'">Copy link to this task</button>';
 if(changeHistory){
  const p=new URLSearchParams(location.search);p.set("task",t.id);
  history.replaceState(null,"",location.pathname+"?"+p.toString());
 }
 if(typeof dialog.showModal==="function"){
  if(!dialog.open)dialog.showModal();
 }else dialog.setAttribute("open","");
 track("task_detail_view",{task_id:t.id,category:t.category});
}
function closeTask(){
 if(dialog.open&&typeof dialog.close==="function")dialog.close();
 else dialog.removeAttribute("open");
 const p=new URLSearchParams(location.search);if(p.has("task")){p.delete("task");history.replaceState(null,"",location.pathname+(p.size?"?"+p.toString():""));}
}
function brief(t){
 return [
 "I want to complete one narrowly scoped task with Highest Degree Priorities.",
 "Task: "+t.title,
 "Desired outcome: "+t.result,
 "Related HDP components: "+t.modules.join("; "),
 "Current business: [describe]",
 "Inputs I can provide: [describe]",
 "Constraints / tools / permissions: [describe]",
 "Desired deliverable: [describe]",
 "Please help define a measurable, bounded deliverable, necessary approvals, price and delivery method. Do not assume an HDP service or third-party integration is available until verified."
 ].join("\n");
}
async function copy(text,done){
 try {await navigator.clipboard.writeText(text);return true;}
 catch(_){const el=document.createElement("textarea");el.value=text;el.style.position="fixed";el.style.left="-9999px";document.body.appendChild(el);el.select();const success=document.execCommand("copy");el.remove();return success;}
}
document.addEventListener("click",async e=>{
 const b=e.target.closest("[data-open-detail]");
 if(b){showTask(b.dataset.openDetail,true);return;}
 if(e.target.closest("[data-close]")){closeTask();return;}
 const filter=e.target.closest("[data-category]");
 if(filter){category=filter.dataset.category;refresh();return;}
 const config=e.target.closest("[data-configure-task]");if(config){track("task_configurator_entry",{task_id:config.dataset.configureTask});return;}
 const tool=e.target.closest("[data-open-tool]");
 if(tool){track("task_open_public_tool",{task_id:tool.dataset.openTool});return;}
 const request=e.target.closest("[data-request-task]");
 if(request){track("task_request_service",{task_id:request.dataset.requestTask});return;}
 const bcopy=e.target.closest("[data-copy-brief]");
 if(bcopy){const t=byId.get(bcopy.dataset.copyBrief);if(t){const success=await copy(brief(t));bcopy.textContent=success?"Copied task brief ✓":"Copy failed · Check browser permissions";track("task_brief_copy",{task_id:t.id});}return;}
 const share=e.target.closest("[data-share-task]");
 if(share){const t=byId.get(share.dataset.shareTask);if(t){const ok=await copy(location.origin+taskLink(t));share.textContent=ok?"Task link copied ✓":"Could not copy link";}return;}
 const menu=e.target.closest("#menuBtn");
 if(menu){const nav=document.getElementById("navLinks");const open=nav.classList.toggle("open");menu.setAttribute("aria-expanded",String(open));return;}
 if(e.target.closest("#navLinks a")){document.getElementById("navLinks").classList.remove("open");document.getElementById("menuBtn").setAttribute("aria-expanded","false");}
});
search.addEventListener("input",refresh);
document.getElementById("availableOnly").addEventListener("change",refresh);
document.getElementById("clearSearch").addEventListener("click",()=>{location.href="/tasks/";});
dialog.addEventListener("click",e=>{if(e.target===dialog)closeTask();});
dialog.addEventListener("close",()=>{const p=new URLSearchParams(location.search);if(p.has("task")){p.delete("task");history.replaceState(null,"",location.pathname+(p.size?"?"+p.toString():""));}});
refresh();
if(params.has("task"))showTask((params.get("task")||"").slice(0,80),false);
track("tasks_marketplace_view",{focused_module:moduleFocus||"none"});
})();