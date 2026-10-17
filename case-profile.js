const API="https://dadban-backend.onrender.com";
const id=new URLSearchParams(location.search).get("id");
const csrf=()=>sessionStorage.getItem("dadban_csrf")||"";
const deleteIdempotencyStorageKey=`dadban:delete:case:${id||"missing"}`;
function deleteIdempotencyKey(){
 let key=localStorage.getItem(deleteIdempotencyStorageKey);
 if(!key){key=crypto.randomUUID();localStorage.setItem(deleteIdempotencyStorageKey,key);}
 return key;
}
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
  const r=await fetch(`${API}/api/cases/${encodeURIComponent(id)}`,{method:"DELETE",credentials:"include",headers:{"x-csrf-token":csrf(),"idempotency-key":deleteIdempotencyKey()}});
  if(r.status===401){location.href="login.html";return}
  if(!r.ok)throw new Error();
  localStorage.removeItem(deleteIdempotencyStorageKey);
  location.href="cases.html?deleted=1";
 }catch{deleteBtn.disabled=false;deleteBtn.textContent="حذف پرونده";$("caseStatus").textContent="حذف پرونده انجام نشد.";}
}
function escapeCaseText(value){
 return String(value??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[ch]));
}
async function loadCaseActions(){
 const list=$("caseActionsList"), summary=$("caseActionsSummary");
 if(!id){list.innerHTML='<div class="empty-state">شناسه پرونده نامعتبر است.</div>';return;}
 try{
  const r=await fetch(`${API}/api/actions?case_id=${encodeURIComponent(id)}&limit=50`,{credentials:"include"});
  if(r.status===401){location.href="login.html";return;}
  const payload=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error();
  const items=Array.isArray(payload?.data)?payload.data:[];
  const open=items.filter(a=>a.status==="todo"||a.status==="in_progress");
  const overdue=open.filter(a=>Boolean(a.is_overdue));
  summary.textContent=overdue.length?`${overdue.length} پیگیری عقب‌افتاده از ${open.length} پیگیری باز`:`${open.length} پیگیری باز؛ مورد عقب‌افتاده‌ای وجود ندارد.`;
  if(!items.length){list.innerHTML='<div class="empty-state">برای این پرونده هنوز پیگیری ثبت نشده است.</div>';return;}
  list.innerHTML=items.slice(0,10).map(a=>{
   const late=Boolean(a.is_overdue)&&(a.status==="todo"||a.status==="in_progress");
   const due=a.due_at?fmt(a.due_at):"بدون مهلت";
   const status={todo:"انجام‌نشده",in_progress:"در حال انجام",completed:"انجام‌شده",cancelled:"لغوشده"}[a.status]||a.status;
   return `<div class="case-action-item${late?" overdue":""}"><div><b>${escapeCaseText(a.title||"اقدام پرونده")}</b><small>${escapeCaseText(status)} · مهلت: ${escapeCaseText(due)}${a.assignee_name?" · مسئول: "+escapeCaseText(a.assignee_name):""}</small>${late?'<span class="overdue-badge">مهلت گذشته</span>':""}</div></div>`;
  }).join("");
  if(items.length>10)summary.textContent+=` نمایش ۱۰ مورد از ${items.length} اقدام.`;
 }catch{summary.textContent="دریافت پیگیری‌های پرونده انجام نشد.";list.innerHTML='<div class="empty-state">برای تلاش دوباره، صفحه را تازه‌سازی کنید.</div>';}
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
  const hearingsLink=$("caseHearingsLink");
  if(hearingsLink) hearingsLink.href=`calendar.html?case_id=${encodeURIComponent(c.id)}`;
  const actionsLink=$("caseActionsLink");
  if(actionsLink) actionsLink.href=`actions.html?case_id=${encodeURIComponent(c.id)}`;
  const actionsAllLink=$("caseActionsAllLink");
  if(actionsAllLink) actionsAllLink.href=`actions.html?case_id=${encodeURIComponent(c.id)}`;
  await loadCaseActions();
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
deleteBtn.addEventListener("click",removeCase);
load();