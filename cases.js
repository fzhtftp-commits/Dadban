const API="https://dadban-backend.onrender.com";
const body=document.getElementById("casesBody"), statusText=document.getElementById("casesStatus"), search=document.getElementById("caseSearch"), filter=document.getElementById("caseStatus");
let cases=[];
const clientId=new URLSearchParams(window.location.search).get("client_id");
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
const statusLabel={active:"فعال",pending:"در انتظار",closed:"بسته",archived:"بایگانی"};
const priorityLabel={low:"کم",normal:"عادی",high:"بالا",urgent:"فوری"};
const formatDate=v=>v?new Intl.DateTimeFormat("fa-IR",{year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(v)): "—";
function render(){
 const q=(search.value||"").trim().toLowerCase(), st=filter.value;
 const list=cases.filter(x=>(!st||x.status===st)&&(!q||[x.case_number,x.title,x.case_type,x.court_name,x.opposing_party,x.client_full_name,x.client_company_name].some(v=>String(v||"").toLowerCase().includes(q))));
 body.innerHTML=list.length?list.map(x=>{const name=x.client_full_name||x.client_company_name||"—";return `<tr><td><a href="case-profile.html?id=${encodeURIComponent(x.id)}">${esc(x.case_number)}</a></td><td>${esc(x.title)}</td><td>${esc(name)}</td><td>${esc(x.case_type||"—")}</td><td><span class="status ${x.status==="active"?"green":"gold"}">${statusLabel[x.status]||esc(x.status)}</span></td><td>${esc(priorityLabel[x.priority]||x.priority||"—")}</td><td>${esc(formatDate(x.next_hearing_at))}</td></tr>`}).join(""):'<tr><td colspan="7" class="empty-state">پرونده‌ای پیدا نشد.</td></tr>';
 statusText.textContent=`${cases.length} پرونده دریافت شد`;
}
async function load(){
 try{
  const url = new URL(`${API}/api/cases`); url.searchParams.set("limit","100"); if (clientId) url.searchParams.set("client_id",clientId);
  const r=await fetch(url.toString(),{credentials:"include"});
  if(r.status===401){location.href="login.html";return}
  if(!r.ok) throw new Error();
  const d=await r.json(); cases=Array.isArray(d?.data)?d.data:[]; render();
  if (clientId) statusText.textContent=`${cases.length} پرونده مرتبط با این موکل دریافت شد`;
 }catch{statusText.textContent="دریافت پرونده‌ها انجام نشد.";body.innerHTML='<tr><td colspan="7" class="empty-state">خطا در ارتباط با سرور.</td></tr>';}
}
search.addEventListener("input",render);filter.addEventListener("change",render);load();