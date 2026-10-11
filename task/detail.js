(function(){
"use strict";
const all=Array.isArray(window.HDP_TASKS)?window.HDP_TASKS:[];
const packages=Array.isArray(window.HDP_PACKAGES)?window.HDP_PACKAGES:[];
const query=new URLSearchParams(location.search);
const requested=(query.get("task")||"reliability-check").slice(0,70);
const task=all.find(x=>x.id===requested)||all[0];
if(!task)return;
const get=id=>document.getElementById(id);
const modules=[...new Set(task.modules)];
const chosen=new Set(modules);
const fields={business_name:"taskBusiness",objective:"taskObjective",inputs:"taskInputs",success_criteria:"taskSuccess",constraints:"taskConstraints"};
const max={business_name:100,objective:1200,inputs:750,success_criteria:750,constraints:750};
const cut=(x,n)=>typeof x==="string"?x.trim().slice(0,n):"";
const escape=x=>String(x??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function track(name,params){if(typeof window.hdpTrackEvent==="function")window.hdpTrackEvent(name,params||{});}
function related(){
 return packages.map(p=>({p,score:p.includes.filter(m=>modules.includes(m)).length}))
   .filter(x=>x.score>0)
   .sort((a,b)=>b.score-a.score||Number(Boolean(b.p.featured))-Number(Boolean(a.p.featured)))
   .slice(0,6).map(x=>x.p);
}
function notify(msg,err=false){get("notice").textContent=msg;get("notice").classList.toggle("error",err);}
function drawModules(){
 get("taskModules").innerHTML=modules.map((name,i)=>'<label class="module-check"><input data-index="'+i+'" type="checkbox" '+(chosen.has(name)?"checked":"")+'> <span>'+escape(name)+'</span></label>').join("");
}
function draft(){
 const values={};for(const [key,id] of Object.entries(fields))values[key]=cut(get(id).value,max[key]);
 return {
 schema:"hdp.task.request-draft",schema_version:1,status:"draft",
 task_id:task.id,task_title:task.title,
 request:values,modules:modules.filter(m=>chosen.has(m)),
 deployment:{status:"NOT_ACTIVE",activation_requires:"verified_paid_order_and_authorized_provisioning"},
 created_at:new Date().toISOString()
 };
}
function renderSummary(){
 const d=draft();
 get("summaryTask").textContent=d.request.business_name||task.title;
 get("summaryCount").textContent=String(d.modules.length);
 get("summaryOutcome").textContent=(d.request.success_criteria||"Not specified").slice(0,180);
}
function setup(){
 document.title=task.title+" | HDP Tasks Marketplace";
 get("crumbName").textContent=task.title;
 get("visualTitle").textContent=task.title;
 get("category").textContent=task.category+" · HDP Tasks Marketplace";
 get("title").textContent=task.title;
 get("summary").textContent=task.summary;
 get("access").textContent=task.access;
 get("resultText").textContent=task.result;
 get("priceLabel").textContent=task.url?"Existing public page + custom service options":"Scoped task quote";
 get("components").innerHTML=modules.map(m=>'<li class="feature-row"><strong>'+escape(m)+'</strong><span>'+escape(window.HDP_MODULE_DESCRIPTIONS?.[m]||"A supporting HDP capability")+'</span><a class="module-task-link" href="/tasks/?module='+encodeURIComponent(m)+'">More tasks using this module →</a></li>').join("");
 const bos=related();
 get("linkedBos").innerHTML=bos.map(p=>'<a href="/business/?package='+encodeURIComponent(p.id)+'">'+escape(p.name)+' ↗</a>').join("");
 if(!bos.length)get("linkedBos").innerHTML="<p>Ask HDP to assemble a custom Business OS from this task.</p>";
 if(task.url&&(task.url.startsWith("/")||task.url.startsWith("https://"))){
   const attrs=task.url.startsWith("https://")?{target:"_blank",rel:"noopener noreferrer"}:{};
   for(const id of ["directTool","usePublic"]){
     const a=get(id);a.hidden=false;a.href=task.url;
     Object.entries(attrs).forEach(([key,value])=>a.setAttribute(key,value));
     a.textContent=task.action+" ↗";
   }
 }
 drawModules();renderSummary();
 track("task_product_view",{task_id:task.id,access:task.access});
}
function exportDraft(){
 const json=JSON.stringify(draft(),null,2)+"\n";
 const ref=URL.createObjectURL(new Blob([json],{type:"application/json;charset=utf-8"}));
 const a=document.createElement("a");a.href=ref;a.download="hdp-task-"+task.id+"-draft.json";document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(ref),30000);
 notify("Task JSON draft downloaded. No entitlement, payment status, credentials, or activation is included.");
 track("task_json_export",{task_id:task.id});
}
function prompt(){
 const d=draft();
 return [
 "Help me configure a single task through Highest Degree Priorities (HDP).",
 "Ask up to five clarifying questions to define a measurable outcome, expected inputs, authorized integrations, permissions, costs, and delivery criteria.",
 "Use only the allowed supporting modules listed below. Do not assert they are deployed or publicly self-service without verifying availability.",
 "Do not request, embed, or return API keys, passwords, tokens, financial card data, or private customer records.",
 "Then return a short scoped service outline and a valid JSON draft with schema hdp.task.request-draft, schema_version 1, and status draft.",
 "The deployment.status must remain NOT_ACTIVE. Imported JSON never provides payment authorization.",
 "",
 "ALLOWED MODULES:",...modules.map(m=>"- "+m),
 "",
 "CURRENT TASK DRAFT:",JSON.stringify(d,null,2)
 ].join("\n");
}
async function copyPrompt(){
 const txt=prompt();let ok=false;
 try{await navigator.clipboard.writeText(txt);ok=true;}
 catch(_){
   const el=document.createElement("textarea");el.value=txt;el.style.position="fixed";el.style.left="-9999px";document.body.appendChild(el);el.select();ok=document.execCommand("copy");el.remove();
 }
 notify(ok?"AI task-scoping prompt copied. Refine it, then import the resulting JSON.":"Clipboard unavailable. Try in a secure browser context.",!ok);
 track("task_prompt_copy",{task_id:task.id});
}
async function importDraft(e){
 const f=e.target.files?.[0];if(!f)return;
 try{
  if(f.size>128*1024)throw Error("Use a JSON draft smaller than 128 KB.");
  const d=JSON.parse(await f.text());
  if(!d||typeof d!=="object"||Array.isArray(d)||d.schema!=="hdp.task.request-draft"||d.schema_version!==1)throw Error("Not a compatible HDP Task draft v1.");
  if(d.task_id!==task.id)throw Error("This configuration belongs to another task. Open that task first.");
  if(!d.request||typeof d.request!=="object"||Array.isArray(d.request)||!Array.isArray(d.modules))throw Error("Missing task request fields.");
  for(const [key,id] of Object.entries(fields))get(id).value=cut(d.request[key],max[key]);
  chosen.clear();for(const name of d.modules){if(typeof name==="string"&&modules.includes(name))chosen.add(name);}
  drawModules();renderSummary();
  notify("Task draft imported. All untrusted payment, entitlement, and activation fields were ignored.");
  track("task_json_import",{task_id:task.id});
 }catch(err){notify("Import failed: "+String(err?.message||"Invalid JSON").slice(0,170),true);}
 finally{e.target.value="";}
}
function request(){
 const d=draft();
 const body=[
 "Hello HDP,",
 "Please provide scope, availability, pricing, and next steps for this individual task.",
 "",
 "Task: "+task.title,
 "Business/project: "+(d.request.business_name||"To discuss"),
 "Objective: "+(d.request.objective||task.result),
 "Inputs available: "+(d.request.inputs||"To discuss"),
 "Completion criteria: "+(d.request.success_criteria||"To discuss"),
 "Constraints: "+(d.request.constraints||"To discuss"),
 "Preferred HDP modules: "+(d.modules.join("; ")||"To discuss"),
 "",
 "Please itemize any service, implementation, recurring, usage or external-provider costs. A paid service should only be activated after checkout and verification.",
 "I can attach an exported JSON draft."
 ].join("\n");
 track("task_checkout_interest",{task_id:task.id});
 location.href="mailto:contact@highestdegreepriorities.com?subject="+encodeURIComponent("HDP individual task: "+task.title)+"&body="+encodeURIComponent(body);
 notify("An email request should open. No checkout or activation occurred.");
}
let example=false;
function toggleExample(){
 if(example){for(const id of Object.values(fields))get(id).value="";example=false;get("example").textContent="Load example";notify("Example cleared.");}
 else{
  get("taskBusiness").value="Example Business";
  get("taskObjective").value=task.result;
  get("taskInputs").value="Public website and approved process notes";
  get("taskSuccess").value="Receive an actionable task result with a clear acceptance checklist";
  get("taskConstraints").value="Use only approved accounts; review before customer communication";
  example=true;get("example").textContent="Clear example";notify("Sample task settings loaded. Nothing has been executed.");
 }
 renderSummary();
 track("task_demo_config",{task_id:task.id});
}
setup();
get("taskModules").addEventListener("change",e=>{
 const index=Number(e.target.dataset.index);
 if(!Number.isInteger(index)||!modules[index])return;
 e.target.checked?chosen.add(modules[index]):chosen.delete(modules[index]);renderSummary();
});
Object.values(fields).forEach(id=>get(id).addEventListener("input",renderSummary));
get("exportDraft").addEventListener("click",exportDraft);
get("copyPrompt").addEventListener("click",copyPrompt);
get("importDraft").addEventListener("change",importDraft);
get("requestScope").addEventListener("click",request);
get("example").addEventListener("click",toggleExample);
["directTool","usePublic"].forEach(id=>get(id).addEventListener("click",()=>track("task_open_public_tool",{task_id:task.id})));
})();