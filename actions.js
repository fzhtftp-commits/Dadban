const API = "https://dadban-backend.onrender.com";
const $ = (id) => document.getElementById(id);
const csrf = () => sessionStorage.getItem("dadban_csrf") || "";
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[ch]));
const toFa = (value) => String(value ?? "").replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]);
const statuses = {todo:"انجام‌نشده",in_progress:"در حال انجام",completed:"انجام‌شده",cancelled:"لغوشده"};
const priorities = {low:"کم",normal:"عادی",high:"بالا",urgent:"فوری"};
const dateTime = (value) => { if(!value)return "—"; const d=new Date(value); return Number.isNaN(d.getTime())?"—":new Intl.DateTimeFormat("fa-IR",{year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}).format(d); };
const localInput = (value) => { if(!value)return ""; const d=new Date(value); if(Number.isNaN(d.getTime()))return ""; return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16); };
const initialCaseId = new URLSearchParams(location.search).get("case_id") || "";
let cases = [];
let actions = [];
const message = (text,type="") => { const el=$("actionMessage"); el.textContent=text; el.className="action-message"+(type?" "+type:""); el.hidden=!text; };
async function request(url, options={}) {
 const response=await fetch(url,{credentials:"include",...options});
 if(response.status===401){location.href="login.html";throw new Error("نشست شما منقضی شده است؛ دوباره وارد شوید.");}
 if(response.status===204)return null;
 const data=await response.json().catch(()=>({}));
 if(!response.ok){
  const errors={
   csrf_token_required:"توکن امنیتی موجود نیست؛ صفحه را تازه‌سازی کنید.",
   csrf_token_invalid:"اعتبار امنیتی درخواست تأیید نشد؛ صفحه را تازه‌سازی کنید.",
   origin_not_allowed:"مبدأ درخواست مجاز نیست.",
   invalid_related_case:"پرونده انتخاب‌شده معتبر نیست یا به این دفتر تعلق ندارد.",
   invalid_assignee:"مسئول انتخاب‌شده معتبر نیست یا عضو فعال این دفتر نیست.",
   invalid_action:"اطلاعات اقدام معتبر نیست؛ عنوان و پرونده را بررسی کنید.",
   invalid_action_update:"اطلاعات ویرایش معتبر نیست.",
   invalid_action_query:"فیلتر اقدامات معتبر نیست.",
   invalid_action_date_range:"بازهٔ مهلت معتبر نیست.",
   action_not_found:"اقدام پیدا نشد یا دیگر در دسترس نیست."
  };
  throw new Error(errors[data.error]||"عملیات انجام نشد؛ لطفاً اطلاعات را بررسی کنید.");
 }
 return data;
}
async function loadCases(){
 const d=await request(API+"/api/cases?limit=100");
 cases=Array.isArray(d?.data)?d.data:[];
 const options=cases.map(c=>'<option value="'+esc(c.id)+'">'+esc((c.case_number||"بدون شماره")+" — "+(c.title||"بدون عنوان"))+'</option>').join("");
 $("caseId").innerHTML='<option value="">انتخاب پرونده</option>'+options;
 $("filterCaseId").innerHTML='<option value="">همه پرونده‌ها</option>'+options;
 if(initialCaseId && cases.some(c=>c.id===initialCaseId)){ $("caseId").value=initialCaseId; $("filterCaseId").value=initialCaseId; }
}
function render(){
 const body=$("actionsBody");
 if(!actions.length){body.innerHTML='<tr><td colspan="5" class="empty-state">اقدامی با این فیلترها پیدا نشد.</td></tr>';return;}
 body.innerHTML=actions.map(a=>{
  const due=a.due_at?dateTime(a.due_at):"بدون مهلت";
  return '<tr><td><b>'+esc(a.title)+'</b><br><small>'+esc(a.case_number||"—")+' · '+esc(a.case_title||"—")+'</small>'+(a.description?'<br><small>'+esc(a.description)+'</small>':"")+'</td><td>'+esc(due)+'</td><td>'+esc(statuses[a.status]||a.status||"—")+'</td><td>'+esc(priorities[a.priority]||a.priority||"—")+'</td><td><div class="action-buttons"><button type="button" data-edit="'+esc(a.id)+'">ویرایش</button>'+(a.status!=="completed"&&a.status!=="cancelled"?'<button type="button" data-complete="'+esc(a.id)+'">اتمام</button>':"")+'<button type="button" class="delete-action" data-delete="'+esc(a.id)+'">حذف</button></div></td></tr>';
 }).join("");
}
async function loadActions(){
 const params=new URLSearchParams();
 if($("filterCaseId").value)params.set("case_id",$("filterCaseId").value);
 if($("filterStatus").value)params.set("status",$("filterStatus").value);
 try{const d=await request(API+"/api/actions?"+params.toString());actions=Array.isArray(d?.data)?d.data:[];render();message("");}
 catch(e){message(e.message||"دریافت اقدامات ناموفق بود.","error");$("actionsBody").innerHTML='<tr><td colspan="5" class="empty-state">دریافت اقدامات انجام نشد.</td></tr>';}
}
function resetForm(){
 $("actionForm").reset();$("actionId").value="";$("actionTitle").value="";$("actionDescription").value="";$("dueAt").value="";
 $("actionStatus").value="todo";$("actionPriority").value="normal";
 if(initialCaseId&&cases.some(c=>c.id===initialCaseId))$("caseId").value=initialCaseId;
 $("formTitle").textContent="ثبت اقدام جدید";$("saveAction").textContent="ثبت اقدام";$("cancelEdit").hidden=true;
}
function editAction(id){
 const a=actions.find(item=>item.id===id);if(!a)return;
 $("actionId").value=a.id;$("caseId").value=a.case_id;$("actionTitle").value=a.title||"";
 $("actionDescription").value=a.description||"";$("dueAt").value=localInput(a.due_at);
 $("actionStatus").value=a.status;$("actionPriority").value=a.priority;
 $("formTitle").textContent="ویرایش اقدام";$("saveAction").textContent="ذخیره تغییرات";$("cancelEdit").hidden=false;
 $("actionForm").scrollIntoView({behavior:"smooth",block:"start"});
}
async function deleteAction(id){
 const a=actions.find(item=>item.id===id);if(!a||!confirm("اقدام «"+a.title+"» به‌صورت حذف نرم از فهرست خارج شود؟"))return;
 try{await request(API+"/api/actions/"+encodeURIComponent(id),{method:"DELETE",headers:{"x-csrf-token":csrf()}});message("اقدام حذف شد.","success");await loadActions();}
 catch(e){message(e.message||"حذف اقدام ناموفق بود.","error");}
}
async function completeAction(id){
 try{await request(API+"/api/actions/"+encodeURIComponent(id),{method:"PATCH",headers:{"Content-Type":"application/json","x-csrf-token":csrf()},body:JSON.stringify({status:"completed"})});message("اقدام انجام‌شده ثبت شد.","success");await loadActions();}
 catch(e){message(e.message||"به‌روزرسانی وضعیت ناموفق بود.","error");}
}
$("actionForm").addEventListener("submit",async event=>{
 event.preventDefault();
 const id=$("actionId").value, due=$("dueAt").value;
 const payload={case_id:$("caseId").value,title:$("actionTitle").value.trim(),description:$("actionDescription").value.trim()||null,due_at:due?new Date(due).toISOString():null,status:$("actionStatus").value,priority:$("actionPriority").value};
 const button=$("saveAction");button.disabled=true;
 try{await request(API+(id?"/api/actions/"+encodeURIComponent(id):"/api/actions"),{method:id?"PATCH":"POST",headers:{"Content-Type":"application/json","x-csrf-token":csrf()},body:JSON.stringify(payload)});resetForm();message(id?"تغییرات اقدام ذخیره شد.":"اقدام با موفقیت ثبت شد.","success");await loadActions();}
 catch(e){message(e.message||"ذخیره اقدام ناموفق بود.","error");}
 finally{button.disabled=false;}
});
$("actionsBody").addEventListener("click",event=>{const target=event.target.closest("button");if(!target)return;if(target.dataset.edit)editAction(target.dataset.edit);if(target.dataset.delete)deleteAction(target.dataset.delete);if(target.dataset.complete)completeAction(target.dataset.complete);});
$("filterCaseId").addEventListener("change",loadActions);$("filterStatus").addEventListener("change",loadActions);
$("clearFilters").addEventListener("click",()=>{$("filterCaseId").value="";$("filterStatus").value="";loadActions();});
$("refreshActions").addEventListener("click",loadActions);$("cancelEdit").addEventListener("click",resetForm);
(async()=>{try{await loadCases();await loadActions();}catch(e){message(e.message||"بارگذاری صفحه ناموفق بود.","error");}})();
