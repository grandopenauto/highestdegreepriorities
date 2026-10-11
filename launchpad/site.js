(function(){
  "use strict";
  const packages=Array.isArray(window.HDP_PACKAGES)?window.HDP_PACKAGES:[];
  const byId=new Map(packages.map(p=>[p.id,p]));
  const picked=new Set();
  const catalog=document.getElementById("catalogCards");
  const featured=document.getElementById("featuredCards");
  const search=document.getElementById("catalogSearch");
  const count=document.getElementById("resultCount");
  const empty=document.getElementById("emptyCatalog");
  const selection=document.getElementById("selectionBar");
  const detail=document.getElementById("packageDetail");
  const detailContent=document.getElementById("detailContent");
  let category="All";

  function track(event,params){if(typeof window.hdpTrackEvent==="function")window.hdpTrackEvent(event,params||{});}
  function safe(s){return String(s||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
  function card(p,mode){
    const selected=picked.has(p.id);
    const featuredMode=mode==="featured";
    return '<article class="package-card" data-id="'+safe(p.id)+'">'+
      '<div class="package-foot"><span class="package-icon" aria-hidden="true">'+safe(p.icon)+'</span><span class="small-tag">'+safe(p.category)+'</span></div>'+
      '<h3>'+safe(p.name)+'</h3><p>'+safe(p.pitch)+'</p><span class="card-spec">Includes '+p.includes.length+' proposed components · Custom quote</span>'+
      (featuredMode?'<div class="package-foot"><span class="tiny-note">'+safe(p.stage)+'</span><button class="text-action" type="button" data-open="'+safe(p.id)+'">Quick details</button></div>':
      '<div class="card-actions"><button class="text-action" type="button" data-open="'+safe(p.id)+'">Quick details</button><button class="add" type="button" data-pick="'+safe(p.id)+'" aria-pressed="'+selected+'">'+(selected?'✓ Selected':'+ Add to mix')+'</button></div>')+
      '<a class="product-page-link" data-analytics="launchpad_product_click" href="/business/?package='+encodeURIComponent(p.id)+'">View full package &amp; configure →</a>'+
      '</article>';
  }
  function refresh(){
    if(featured)featured.innerHTML=packages.filter(p=>p.featured).slice(0,4).map(p=>card(p,"featured")).join("");
    if(!catalog)return;
    const q=(search?.value||"").trim().toLowerCase();
    const visible=packages.filter(p=>(category==="All"||p.category===category)&&(!q||[p.name,p.pitch,p.category,p.outcome,...p.includes,...p.options].join(" ").toLowerCase().includes(q)));
    catalog.innerHTML=visible.map(p=>card(p,"catalog")).join("");
    if(count)count.textContent=visible.length+" of "+packages.length+" business blueprints";
    if(empty)empty.hidden=visible.length!==0;
    document.querySelectorAll("[data-category]").forEach(el=>el.setAttribute("aria-pressed",String(el.dataset.category===category)));
    if(selection){
      selection.hidden=picked.size===0;
      const names=[...picked].map(id=>byId.get(id)?.name).filter(Boolean);
      document.getElementById("pickCount").textContent=picked.size+" selected";
      document.getElementById("pickNames").textContent=names.length?names.join(" · "):"";
    }
  }
  function openPackage(id){
    const p=byId.get(id);
    if(!p||!detail||!detailContent)return;
    detailContent.innerHTML='<div class="eyebrow">'+safe(p.category)+' · '+safe(p.stage)+'</div>'+
      '<h2 id="dialogTitle">'+safe(p.name)+'</h2><p>'+safe(p.pitch)+'</p>'+
      '<h3>What this blueprint helps you organize</h3><p>'+safe(p.outcome)+'</p>'+
      '<h3>HDP building blocks</h3><ul>'+p.includes.map(t=>'<li>'+safe(t)+'</li>').join("")+'</ul>'+
      '<h3>Service and integration choices</h3><ul>'+p.options.map(t=>'<li>'+safe(t)+'</li>').join("")+'</ul>'+
      '<div class="dialog-actions"><button type="button" class="btn navy" data-pick="'+safe(p.id)+'">'+(picked.has(p.id)?"✓ Remove from mix":"+ Add to my business mix")+'</button>'+
      '<a class="btn gold" data-analytics="launchpad_product_click" href="/business/?package='+encodeURIComponent(p.id)+'">Full package &amp; configurator →</a></div>'+
      '<p class="legalnote">Blueprints are configurable starting points, not claims that every component is deployed, licensed, integrated or ready for immediate customer use. Scope and availability are confirmed during planning.</p>';
    track("launchpad_package_view",{package_id:p.id,category:p.category});
    if(typeof detail.showModal==="function")detail.showModal();else detail.setAttribute("open","");
  }
  function makeMailto(list){
    const names=list.map(p=>p.name).join(", ");
    const subj="HDP Business Launchpad — "+(list.length>1?"Custom business mix":"Business package")+" inquiry";
    const body="Hello HDP,\n\nI would like to explore a business launch or operations plan.\n\nInterested blueprints:\n"+list.map(p=>"- "+p.name).join("\n")+
    "\n\nMy goals / existing tools:\n\n\nPreferred timeline:\n\n\nPlease help identify which components are available, what integrations are needed, and the next steps.\n";
    return "mailto:contact@highestdegreepriorities.com?subject="+encodeURIComponent(subj)+"&body="+encodeURIComponent(body);
  }
  document.addEventListener("click",function(e){
    const opener=e.target.closest("[data-open]");if(opener){openPackage(opener.dataset.open);return;}
    const picker=e.target.closest("[data-pick]");if(picker){
      const id=picker.dataset.pick;if(!byId.has(id))return;
      picked.has(id)?picked.delete(id):picked.add(id);
      track("launchpad_mix_changed",{package_id:id,selection_count:picked.size});
      refresh();
      if(detail?.open){openPackageRefresh(id);}
      return;
    }
    const categoryBtn=e.target.closest("[data-category]");if(categoryBtn){category=categoryBtn.dataset.category;refresh();return;}
    const pickAll=e.target.closest("[data-plan-mix]");if(pickAll){
      const list=[...picked].map(id=>byId.get(id)).filter(Boolean);
      track("launchpad_mix_requested",{selection_count:list.length});
      window.location.href=makeMailto(list);return;
    }
    const close=e.target.closest("[data-close-dialog]");if(close&&detail){detail.close();return;}
    const menu=e.target.closest("#menuBtn");if(menu){const nav=document.getElementById("navLinks");const isOpen=nav.classList.toggle("open");menu.setAttribute("aria-expanded",String(isOpen));return;}
    if(e.target.closest("#navLinks a")){document.getElementById("navLinks")?.classList.remove("open");document.getElementById("menuBtn")?.setAttribute("aria-expanded","false");}
  });
  function openPackageRefresh(id){const p=byId.get(id);const button=detailContent?.querySelector("[data-pick]");if(p&&button)button.textContent=picked.has(id)?"✓ Remove from mix":"+ Add to my business mix";}
  detail?.addEventListener("click",e=>{if(e.target===detail)detail.close();});
  search?.addEventListener("input",refresh);
  document.getElementById("catalogForm")?.addEventListener("submit",e=>{e.preventDefault();document.getElementById("catalog")?.scrollIntoView({behavior:"smooth"});});
  document.querySelectorAll("[data-jump-category]").forEach(btn=>btn.addEventListener("click",()=>{
    category=btn.dataset.jumpCategory||"All";if(search)search.value="";
    refresh();document.getElementById("catalog")?.scrollIntoView({behavior:"smooth"});
  }));
  // Front-door search uses the same filters as the full catalog.
  document.getElementById("heroSearchForm")?.addEventListener("submit",function(e){
    e.preventDefault();
    const query=document.getElementById("heroSearch")?.value||"";
    if(search)search.value=query;
    category="All";
    refresh();
    track("launchpad_hero_search",{search_length:query.length});
    document.getElementById("catalog")?.scrollIntoView({behavior:"smooth"});
    search?.focus({preventScroll:true});
  });
  refresh();
})();