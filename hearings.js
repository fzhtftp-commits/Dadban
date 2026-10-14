const API = "https://dadban-backend.onrender.com";
const $ = (id) => document.getElementById(id);
const csrf = () => sessionStorage.getItem("dadban_csrf") || "";
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[ch]));
const toFa = (value) => String(value ?? "").replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]);
const statusLabels = {scheduled:"برنامه‌ریزی‌شده",completed:"برگزارشده",postponed:"به تعویق افتاده",cancelled:"لغوشده"};
const formatDate = (value) => { const d = new Date(value); return Number.isNaN(d.getTime()) ? "—" : new Intl.DateTimeFormat("fa-IR",{year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}).format(d); };
let hearings = [];
let cases = [];
const initialCaseId = new URLSearchParams(window.location.search).get("case_id") || "";
const message = (text, type = "") => { const el=$("pageMessage"); el.textContent=text; el.className="calendar-message"+(type?" "+type:""); el.hidden=!text; };
const toLocalInput = (value) => { if(!value)return ""; const d=new Date(value); if(Number.isNaN(d.getTime()))return ""; const offset=d.getTimezoneOffset()*60000; return new Date(d.getTime()-offset).toISOString().slice(0,16); };
async function request(url, options={}) {
 const response = await fetch(url,{credentials:"include",...options});
 if(response.status===401){location.href="login.html";throw new Error("نشست شما منقضی شده است؛ دوباره وارد شوید.");}
 if(response.status===204)return null;
 const data=await response.json().catch(()=>({}));
 if(!response.ok) throw new Error(data.error==="invalid_related_case"?"پرونده انتخاب‌شده معتبر نیست.":data.error==="hearing_not_found"?"جلسه پیدا نشد.":"عملیات انجام نشد؛ لطفاً اطلاعات را بررسی کنید.");
 return data;
}
async function loadCases(){
 const d=await request(API+"/api/cases?limit=100");
 cases=Array.isArray(d?.data)?d.data:[];
 const caseOptions=cases.map(c=>'<option value="'+esc(c.id)+'">'+esc((c.case_number||"بدون شماره")+" — "+(c.title||"بدون عنوان")+" — "+(c.client_full_name||c.client_company_name||"بدون موکل"))+'</option>').join("");
 $("filterCaseId").innerHTML='<option value="">همه پرونده‌ها</option>'+caseOptions;
 if(initialCaseId && cases.some(c=>c.id===initialCaseId)) { $("filterCaseId").value=initialCaseId; $("caseId").value=initialCaseId; }
 $("caseId").innerHTML='<option value="">انتخاب پرونده</option>'+cases.map(c=>'<option value="'+esc(c.id)+'">'+esc((c.case_number||"بدون شماره")+" — "+(c.title||"بدون عنوان")+" — "+(c.client_full_name||c.client_company_name||"بدون موکل"))+'</option>').join("");
}
function render(){
 const body=$("hearingsBody");
 $("hearingCount").textContent=toFa(hearings.length);
 if(!hearings.length){body.innerHTML='<tr><td colspan="6" class="empty-state">جلسه‌ای با این فیلترها پیدا نشد.</td></tr>';return;}
 body.innerHTML=hearings.map(h=>{
  const client=h.client_full_name||h.client_company_name||"—";
  const court=[h.court_name,h.branch_name].filter(Boolean).join("، ")||"—";
  return '<tr><td>'+esc(formatDate(h.hearing_at))+'<br><small>'+esc(h.hearing_type||"جلسه")+'</small></td><td><b>'+esc(h.case_number||"—")+'</b><br>'+esc(h.case_title||"—")+'<br><small>'+esc(client)+'</small></td><td>'+esc(court)+'</td><td>'+esc(statusLabels[h.status]||h.status||"—")+'</td><td>'+esc(h.reminder_minutes===0?"بدون یادآوری":(h.reminder_minutes>=10080?toFa(Math.round(h.reminder_minutes/10080))+" هفته قبل":h.reminder_minutes>=1440?toFa(Math.round(h.reminder_minutes/1440))+" روز قبل":toFa(h.reminder_minutes)+" دقیقه قبل"))+'</td><td><div class="calendar-actions"><button type="button" data-edit="'+esc(h.id)+'">ویرایش</button><button class="delete-hearing" type="button" data-delete="'+esc(h.id)+'">حذف</button></div></td></tr>';
 }).join("");
}
async function loadHearings(){
 const params=new URLSearchParams();
 if($("filterStatus").value)params.set("status",$("filterStatus").value);
 const selectedCaseId=$("filterCaseId").value;
 if(selectedCaseId)params.set("case_id",selectedCaseId);
 const from=$("filterFrom").value, to=$("filterTo").value;
 if(from && to && from > to) {
  message("تاریخ شروع نباید بعد از تاریخ پایان باشد.","error");
  return;
 }
 if(from)params.set("from",new Date(from+"T00:00:00").toISOString());
 if(to)params.set("to",new Date(to+"T23:59:59").toISOString());
 try{const d=await request(API+"/api/hearings?"+params.toString());hearings=Array.isArray(d?.data)?d.data:[];render();message("");}
 catch(e){message(e.message||"دریافت جلسات ناموفق بود.","error");$("hearingsBody").innerHTML='<tr><td colspan="6" class="empty-state">دریافت جلسات انجام نشد.</td></tr>';}
}
function resetForm(){
 $("hearingForm").reset();$("hearingId").value="";$("hearingType").value="جلسه دادرسی";$("hearingStatus").value="scheduled";$("reminderMinutes").value="1440";
 $("formTitle").textContent="ثبت جلسه جدید";$("saveHearing").textContent="ثبت جلسه";$("cancelEdit").hidden=true;
}
function editHearing(id){
 const h=hearings.find(item=>item.id===id);if(!h)return;
 $("hearingId").value=h.id;$("caseId").value=h.case_id;$("hearingAt").value=toLocalInput(h.hearing_at);
 $("hearingType").value=h.hearing_type||"جلسه دادرسی";$("courtName").value=h.court_name||"";$("branchName").value=h.branch_name||"";
 $("hearingStatus").value=h.status;$("reminderMinutes").value=String(h.reminder_minutes??1440);$("hearingNotes").value=h.notes||"";
 $("formTitle").textContent="ویرایش جلسه";$("saveHearing").textContent="ذخیره تغییرات";$("cancelEdit").hidden=false;
 $("hearingForm").scrollIntoView({behavior:"smooth",block:"start"});
}
async function deleteHearing(id){
 const h=hearings.find(item=>item.id===id);if(!h||!confirm("جلسه انتخاب‌شده حذف نرم شود؟"))return;
 try{await request(API+"/api/hearings/"+encodeURIComponent(id),{method:"DELETE",headers:{"x-csrf-token":csrf()}});message("جلسه حذف شد.","success");await loadHearings();}
 catch(e){message(e.message||"حذف جلسه ناموفق بود.","error");}
}
$("hearingForm").addEventListener("submit",async event=>{
 event.preventDefault();
 const id=$("hearingId").value, dt=$("hearingAt").value;
 if(!dt){message("تاریخ و ساعت جلسه را وارد کنید.","error");return;}
 const payload={case_id:$("caseId").value,hearing_at:new Date(dt).toISOString(),hearing_type:$("hearingType").value.trim(),court_name:$("courtName").value.trim()||null,branch_name:$("branchName").value.trim()||null,status:$("hearingStatus").value,reminder_minutes:Number($("reminderMinutes").value),notes:$("hearingNotes").value.trim()||null};
 const button=$("saveHearing");button.disabled=true;
 try{await request(API+(id?"/api/hearings/"+encodeURIComponent(id):"/api/hearings"),{method:id?"PATCH":"POST",headers:{"Content-Type":"application/json","x-csrf-token":csrf()},body:JSON.stringify(payload)});resetForm();message(id?"تغییرات جلسه ذخیره شد.":"جلسه با موفقیت ثبت شد.","success");await loadHearings();}
 catch(e){message(e.message||"ذخیره جلسه ناموفق بود.","error");}
 finally{button.disabled=false;}
});
$("hearingsBody").addEventListener("click",event=>{const edit=event.target.closest("[data-edit]"),del=event.target.closest("[data-delete]");if(edit)editHearing(edit.dataset.edit);if(del)deleteHearing(del.dataset.delete);});
$("filterCaseId").addEventListener("change",loadHearings);
$("filterStatus").addEventListener("change",loadHearings);$("filterFrom").addEventListener("change",loadHearings);$("filterTo").addEventListener("change",loadHearings);
$("clearFilters").addEventListener("click",()=>{$("filterStatus").value="";$("filterCaseId").value="";$("filterFrom").value="";$("filterTo").value="";loadHearings();});
$("refreshHearings").addEventListener("click",loadHearings);$("cancelEdit").addEventListener("click",resetForm);
(async()=>{try{await loadCases();await loadHearings();}catch(e){message(e.message||"بارگذاری صفحه ناموفق بود.","error");}})();
