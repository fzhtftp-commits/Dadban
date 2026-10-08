const API="https://dadban-backend.onrender.com";
const id=new URLSearchParams(location.search).get("id");
const csrf=()=>sessionStorage.getItem("dadban_csrf")||"";
const $=x=>document.getElementById(x);
const statusLabel={active:"فعال",pending:"در انتظار",closed:"بسته",archived:"بایگانی"};
const priorityLabel={low:"کم",normal:"عادی",high:"بالا",urgent:"فوری"};
const fmt=v=>v?new Intl.DateTimeFormat("fa-IR",{year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(v)):"—";
const editBtn=$("editCase"), deleteBtn=$("deleteCase");
async function removeCase(){
 if(!id)return;
 if(!confirm("آیا از حذف این پرونده مطمئن هستید؟\n\nاین عملیات حذف نرم است و اطلاعات برای سوابق امنیتی نگهداری می‌شود."))return;
 deleteBtn.disabled=true; deleteBtn.textContent="در حال حذف...";
 try{
  const r=await fetch(`${API}/api/cases/${encodeURIComponent(id)}`,{method:"DELETE",credentials:"include",headers:{"x-csrf-token":csrf()}});
  if(r.status===401){location.href="login.html";return}
  if(!r.ok)throw new Error();
  location.href="cases.html?deleted=1";
 }catch{deleteBtn.disabled=false;deleteBtn.textContent="حذف پرونده";$("caseStatus").textContent="حذف پرونده انجام نشد.";}
}
async function load(){
 if(!id){ $("caseStatus").textContent="شناسه پرونده نامعتبر است."; editBtn.style.display="none"; deleteBtn.style.display="none"; return; }
 try{
  const r=await fetch(`${API}/api/cases/${encodeURIComponent(id)}`,{credentials:"include"});
  const d=await r.json().catch(()=>({}));
  if(r.status===401){location.href="login.html";return}
  if(r.status===404){$("caseStatus").textContent="پرونده پیدا نشد.";return}
  if(!r.ok)throw new Error();
  const c=d.data;
  $("caseTitle").textContent=c.title||"پرونده";
  editBtn.href=`case-form.html?id=${encodeURIComponent(c.id)}`;
  deleteBtn.disabled=false;
  $("caseStatus").textContent=`● ${statusLabel[c.status]||"پرونده"}`;
  $("caseNumber").textContent=c.case_number||"—";
  $("caseNumberHero").textContent=`شماره پرونده: ${c.case_number||"—"}`;
  $("clientName").textContent=c.client_full_name||c.client_company_name||"—";
  $("caseType").textContent=c.case_type||"—";
  $("courtName").textContent=c.court_name||"—";
  $("branchName").textContent=c.branch_name||"—";
  $("opposingParty").textContent=c.opposing_party||"—";
  $("statusValue").textContent=statusLabel[c.status]||c.status||"—";
  $("priorityValue").textContent=priorityLabel[c.priority]||c.priority||"—";
  $("summaryStatus").textContent=statusLabel[c.status]||c.status||"—";
  $("summaryPriority").textContent=priorityLabel[c.priority]||c.priority||"—";
  $("filingDate").textContent=fmt(c.filing_date);
  $("hearingDate").textContent=fmt(c.next_hearing_at);
  $("summaryHearing").textContent=fmt(c.next_hearing_at);
  $("description").textContent=c.description||"—";
  $("notes").textContent=c.notes||"—";
 }catch{ $("caseStatus").textContent="خطا در دریافت اطلاعات پرونده."; }
}
deleteBtn.addEventListener("click",removeCase);\nload();