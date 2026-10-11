(function(){
"use strict";
const all=Array.isArray(window.HDP_PACKAGES)?window.HDP_PACKAGES:[];
const params=new URLSearchParams(location.search);
const id=(params.get("package")||"voice-agency").slice(0,70);
const product=all.find(x=>x.id===id)||all.find(x=>x.id==="voice-agency");
if(!product)return;
const g=id=>document.getElementById(id);
const modules=[...new Set(product.includes)];
const selected=new Set(modules);
const limits={name:100,goal:1200,audience:150,service_area:150,notes:300};
const fields={name:"businessName",goal:"businessGoal",audience:"audience",service_area:"serviceArea"};
const escape=s=>String(s||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const cut=(s,n)=>typeof s==="string"?s.trim().slice(0,n):"";
function track(event,details){if(typeof window.hdpTrackEvent==="function")window.hdpTrackEvent(event,details||{});}
let demoOn=false;
document.title=product.name+" | HDP Business Launchpad";
for(const [id,value] of Object.entries({
  breadcrumbName:product.name,businessCategory:product.category+" · HDP Business Package",
  businessTitle:product.name,businessPitch:product.pitch,businessStage:product.stage,
  businessOutcome:product.outcome,visualName:product.name,summaryPackage:product.name
}))g(id).textContent=value;
g("systemList").innerHTML=modules.map(x=>"<li class=\"feature-row\"><strong>"+escape(x)+"</strong><span>"+escape(window.HDP_MODULE_DESCRIPTIONS?.[x]||"Include this component in the agreed scope.")+"</span><a class=\"module-task-link\" href=\"/tasks/?module="+encodeURIComponent(x)+"\">Explore individual tasks using this capability →</a></li>").join("");
g("optionList").innerHTML=product.options.map(x=>"<li>"+escape(x)+"</li>").join("");
function renderModules(){g("moduleChecks").innerHTML=modules.map((m,i)=>'<label class="module-check"><input type="checkbox" data-module="'+i+'" '+(selected.has(m)?"checked":"")+'> <span>'+escape(m)+"</span></label>").join("");}
function draft(){
  const business={};for(const [key,id] of Object.entries(fields))business[key]=cut(g(id).value,limits[key]);
  let mode=document.querySelector('input[name="providerMode"]:checked')?.value||"hdp";
  if(!["hdp","mixed","existing"].includes(mode))mode="hdp";
  return {
    schema:"hdp.business.launch-draft",schema_version:1,status:"draft",
    package_id:product.id,package_name:product.name,
    business,modules:modules.filter(m=>selected.has(m)),
    provider:{mode,notes:cut(g("providerNotes").value,limits.notes)},
    deployment:{status:"NOT_ACTIVE",activation_requires:"verified_paid_order_and_authorized_provisioning"},
    exported_at:new Date().toISOString()
  };
}
function update(){
 const d=draft();
 g("summaryName").textContent=d.business.name||"New Business";
 g("summaryModuleCount").textContent=String(d.modules.length);
 g("summaryProvider").textContent=({hdp:"HDP preferred",mixed:"HDP + external",existing:"Keep existing tools"})[d.provider.mode];
 g("demoToggle").textContent=demoOn?"Clear sample configuration":"Try sample configuration";
}
function notice(text,error=false){g("actionNotice").textContent=text;g("actionNotice").classList.toggle("error",error);}
function exportDraft(){
 const src=JSON.stringify(draft(),null,2)+"\n";
 const u=URL.createObjectURL(new Blob([src],{type:"application/json;charset=utf-8"}));
 const a=document.createElement("a");a.href=u;a.download="hdp-"+product.id+"-draft.json";document.body.appendChild(a);a.click();a.remove();
 setTimeout(()=>URL.revokeObjectURL(u),30000);
 notice("JSON draft downloaded. This is a configuration preference file, not an activation token.");
 track("launchpad_json_export",{package_id:product.id,module_count:selected.size});
}
function prompt(){
 const d=draft();
 return [
 "You are helping me configure an HDP Business Launchpad business-in-a-box.",
 "Ask up to five high-value questions to clarify the business offer, customers, operations, permissions, integrations, pricing assumptions and compliance.",
 "Below is an HDP launch draft. Refine the business fields and choose modules ONLY from the exact allowed list.",
 "Respond with a short explanation followed by a valid JSON object matching schema hdp.business.launch-draft v1.",
 "Keep status draft and deployment.status NOT_ACTIVE. No live execution, activation or payment.",
 "Never include API keys, passwords, secrets, payment card data, or private personal details. Do not claim a provider integration exists unless verified.",
 "",
 "ALLOWED MODULES:",
 ...modules.map(x=>"- "+x),
 "",
 "STARTING CONFIGURATION:",
 JSON.stringify(d,null,2),
 "",
 "Return only whitelisted module names and a provider.mode of hdp, mixed, or existing. Keep all deployment identifiers untrusted and inactive."
 ].join("\n");
}
async function copyPrompt(){
 const content=prompt();
 try{
   await navigator.clipboard.writeText(content);
   notice("AI setup prompt copied. Paste it into ChatGPT, refine the business, then import the resulting JSON.");
 }catch(_){
   const el=document.createElement("textarea");el.value=content;el.style.position="fixed";el.style.left="-9999px";document.body.appendChild(el);el.select();
   const ok=document.execCommand("copy");el.remove();
   notice(ok?"AI setup prompt copied.":"Clipboard unavailable. Use a secure browser context to copy the prompt.",!ok);
 }
 track("launchpad_prompt_copy",{package_id:product.id});
}
function importDraft(obj){
 if(!obj||typeof obj!=="object"||Array.isArray(obj))throw Error("A JSON object is required.");
 if(obj.schema!=="hdp.business.launch-draft"||obj.schema_version!==1)throw Error("This is not an HDP launch draft v1.");
 if(obj.package_id!==product.id)throw Error("This JSON draft belongs to another business package. Open that package first.");
 if(!obj.business||typeof obj.business!=="object"||Array.isArray(obj.business))throw Error("Business information is missing.");
 if(!Array.isArray(obj.modules))throw Error("Module selection is missing.");
 for(const [key,id] of Object.entries(fields))g(id).value=cut(obj.business[key],limits[key]);
 selected.clear();for(const m of obj.modules)if(typeof m==="string"&&modules.includes(m))selected.add(m);
 const mode=["hdp","mixed","existing"].includes(obj.provider?.mode)?obj.provider.mode:"hdp";
 document.querySelector('input[name="providerMode"][value="'+mode+'"]').checked=true;
 g("providerNotes").value=cut(obj.provider?.notes,limits.notes);
 // Never trust imported status, secrets, payment fields, account IDs or entitlements.
 demoOn=false;renderModules();update();
 notice("JSON draft imported. Payment and activation remain unverified and inactive.");
 track("launchpad_json_import",{package_id:product.id,module_count:selected.size});
}
async function handleImport(e){
 const f=e.target.files?.[0];if(!f)return;
 try{if(f.size>128*1024)throw Error("File exceeds 128 KB.");importDraft(JSON.parse(await f.text()));}
 catch(err){notice("Import failed: "+String(err?.message||"Invalid JSON").slice(0,170),true);}
 finally{e.target.value="";}
}
function requestOrder(){
 const d=draft();
 const body=[
 "Hello HDP,","",
 "Please prepare an itemized scope, price and secure checkout for this business package.","",
 "Package: "+d.package_name,
 "Business name: "+(d.business.name||"To discuss"),
 "Goal: "+(d.business.goal||"To discuss"),
 "Customers: "+(d.business.audience||"To discuss"),
 "Service area: "+(d.business.service_area||"To discuss"),
 "Modules: "+d.modules.join("; "),
 "Provider model: "+d.provider.mode,
 "Provider notes: "+(d.provider.notes||"None"),
 "",
 "Please detail setup, subscriptions, usage and third-party costs, and the order approval and activation steps.",
 "I understand this inquiry does not constitute a purchase. I can attach the JSON draft."
 ].join("\n");
 track("launchpad_checkout_request",{package_id:product.id,module_count:d.modules.length});
 location.href="mailto:contact@highestdegreepriorities.com?subject="+encodeURIComponent("HDP checkout request: "+product.name)+"&body="+encodeURIComponent(body);
 notice("Your email client should open an order request. No payment has been taken or service activated.");
}
function toggleDemo(){
 if(demoOn){
  for(const fid of Object.values(fields))g(fid).value="";
  g("providerNotes").value="";
  document.querySelector('input[name="providerMode"][value="hdp"]').checked=true;
  demoOn=false;notice("Example cleared. Enter your own business details.");
 }else{
  g("businessName").value="Example "+product.name;
  g("businessGoal").value=product.outcome;
  g("audience").value="Local organizations exploring this service";
  g("serviceArea").value="Pilot region (example)";
  g("providerNotes").value="Please recommend compatible alternatives";
  document.querySelector('input[name="providerMode"][value="mixed"]').checked=true;
  demoOn=true;notice("Example loaded. This is only a UI walkthrough, not a live system configuration.");
  document.getElementById("configure")?.scrollIntoView({behavior:"smooth"});
 }
 selected.clear();modules.forEach(m=>selected.add(m));renderModules();update();
 track("launchpad_sample_demo",{package_id:product.id});
}
renderModules();update();track("launchpad_product_view",{package_id:product.id});
g("moduleChecks").addEventListener("change",e=>{
 const idx=Number(e.target.dataset.module);if(!Number.isInteger(idx)||!modules[idx])return;
 e.target.checked?selected.add(modules[idx]):selected.delete(modules[idx]);update();
});
for(const id of Object.values(fields))g(id).addEventListener("input",update);
g("providerNotes").addEventListener("input",update);
document.querySelectorAll('input[name="providerMode"]').forEach(el=>el.addEventListener("change",update));
g("exportJson").addEventListener("click",exportDraft);
g("copyPrompt").addEventListener("click",copyPrompt);
g("importJson").addEventListener("change",handleImport);
g("requestOrder").addEventListener("click",requestOrder);
g("demoToggle").addEventListener("click",toggleDemo);
})();