const API="https://dadban-backend.onrender.com";
const id=new URLSearchParams(location.search).get("id");
const $=x=>document.getElementById(x);
const statusLabel={active:"فعال",pending:"در انتظار",closed:"بسته",archived:"بایگانی"};
const priorityLabel={low:"کم",normal:"عادی",high:"بالا",urgent:"فوری"};
const fmt=v=>v?new Intl.DateTimeFormat("fa-IR",{year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(v)):"—";
async function load(){
 if(!id){ $("caseStatus").textContent="شناسه پرونده نامعتبر است."; return; }
 try{
  const r=await fetch(`${API}/api/cases/${encodeURIComponent(id)}`,{credentials:"include"});
  const d=await r.json().catch(()=>({}));
  if(r.status===401){location.href="login.html";return}
  if(r.status===404){$("caseStatus").textContent="پرونده پیدا نشد.";return}
  if(!r.ok)throw new Error();
  const c=d.data;
  $("caseTitle").textContent=c.title||"پرونده";
  $("caseStatus").textContent="اطلاعات پرونده";
  $("caseNumber").textContent=c.case_number||"—";
  $("clientName").textContent=c.client_full_name||c.client_company_name||"—";
  $("caseType").textContent=c.case_type||"—";
  $("courtName").textContent=c.court_name||"—";
  $("branchName").textContent=c.branch_name||"—";
  $("opposingParty").textContent=c.opposing_party||"—";
  $("statusValue").textContent=statusLabel[c.status]||c.status||"—";
  $("priorityValue").textContent=priorityLabel[c.priority]||c.priority||"—";
  $("filingDate").textContent=fmt(c.filing_date);
  $("hearingDate").textContent=fmt(c.next_hearing_at);
  $("description").textContent=c.description||"—";
  $("notes").textContent=c.notes||"—";
 }catch{ $("caseStatus").textContent="خطا در دریافت اطلاعات پرونده."; }
}
load();