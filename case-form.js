const API="https://dadban-backend.onrender.com";
const params=new URLSearchParams(location.search);
const caseId=params.get("id");
const form=document.getElementById("caseForm"),clientId=document.getElementById("client_id"),nationalId=document.getElementById("client_national_id"),lookupMessage=document.getElementById("clientLookupMessage"),msg=document.getElementById("formMessage"),btn=document.getElementById("saveCase");
const csrf=()=>sessionStorage.getItem("dadban_csrf")||"";
const message=(t,ok=false)=>{msg.hidden=false;msg.textContent=t;msg.className="form-message"+(ok?" success-message":"")};
const normalizeDigits=v=>String(v||"").replace(/[۰-۹]/g,d=>"۰۱۲۳۴۵۶۷۸۹".indexOf(d)).replace(/[٠-٩]/g,d=>"٠١٢٣٤٥٦٧٨٩".indexOf(d));
let lookupTimer;
async function lookupClient(){
 const value=normalizeDigits(nationalId.value).replace(/\D/g,"");
 nationalId.value=value; clientId.value="";
 if(value.length!==10){lookupMessage.textContent="کد ملی را وارد کنید تا نام موکل نمایش داده شود.";lookupMessage.style.color="";return false}
 lookupMessage.textContent="در حال بررسی کد ملی...";
 try{
  const r=await fetch(`${API}/api/clients/lookup?national_id=${encodeURIComponent(value)}`,{credentials:"include"});
  if(r.status===401){location.href="login.html";return false}
  const d=await r.json().catch(()=>({}));
  if(r.status===404){lookupMessage.textContent="موکلی با این کد ملی پیدا نشد.";lookupMessage.style.color="#b24b4b";return false}
  if(!r.ok)throw new Error();
  clientId.value=d.data.id; lookupMessage.textContent=`موکل: ${d.data.full_name||d.data.company_name||"—"}`; lookupMessage.style.color="#39734d"; return true;
 }catch{lookupMessage.textContent="خطا در بررسی کد ملی.";lookupMessage.style.color="#b24b4b";return false}
}
nationalId.addEventListener("input",()=>{clearTimeout(lookupTimer);lookupTimer=setTimeout(lookupClient,350)});
const setValue=(id,v)=>{const el=document.getElementById(id);if(el)el.value=v??""};
async function loadCase(){
 if(!caseId)return;
 document.title="دادبان | ویرایش پرونده"; document.querySelector("h1").textContent="ویرایش پرونده";
 try{
  const r=await fetch(`${API}/api/cases/${encodeURIComponent(caseId)}`,{credentials:"include"});
  const d=await r.json().catch(()=>({}));
  if(r.status===401){location.href="login.html";return}
  if(!r.ok)throw new Error(d.error||"دریافت پرونده انجام نشد.");
  const c=d.data;
  setValue("client_national_id",c.national_id||""); clientId.value=c.client_id||"";
  lookupMessage.textContent=`موکل: ${c.client_full_name||c.client_company_name||"—"}`; lookupMessage.style.color="#39734d";
  setValue("case_number",c.case_number); setValue("title",c.title); setValue("case_type",c.case_type); setValue("court_name",c.court_name); setValue("branch_name",c.branch_name); setValue("opposing_party",c.opposing_party);
  setValue("status",c.status||"active"); setValue("priority",c.priority||"normal"); setValue("filing_date",c.filing_date?String(c.filing_date).slice(0,10):""); setValue("next_hearing_at",c.next_hearing_at?new Date(c.next_hearing_at).toISOString().slice(0,16):""); setValue("description",c.description); setValue("notes",c.notes);
  btn.textContent="ذخیره تغییرات";
 }catch(e){message(e.message||"خطا در دریافت اطلاعات پرونده.");btn.disabled=true}
}
async function save(e){
 e.preventDefault();
 if(!clientId.value){message("ابتدا کد ملی معتبر یک موکل موجود را وارد کنید.");return}
 btn.disabled=true; btn.textContent=caseId?"در حال ذخیره تغییرات...":"در حال ذخیره...";
 try{
  const dt=document.getElementById("next_hearing_at").value;
  const payload={client_id:clientId.value,case_number:document.getElementById("case_number").value.trim(),title:document.getElementById("title").value.trim(),case_type:document.getElementById("case_type").value.trim()||null,court_name:document.getElementById("court_name").value.trim()||null,branch_name:document.getElementById("branch_name").value.trim()||null,opposing_party:document.getElementById("opposing_party").value.trim()||null,status:document.getElementById("status").value,priority:document.getElementById("priority").value,filing_date:document.getElementById("filing_date").value||null,next_hearing_at:dt?new Date(dt).toISOString():null,description:document.getElementById("description").value.trim()||null,notes:document.getElementById("notes").value.trim()||null};
  const r=await fetch(caseId?`${API}/api/cases/${encodeURIComponent(caseId)}`:`${API}/api/cases`,{method:caseId?"PATCH":"POST",credentials:"include",headers:{"Content-Type":"application/json","x-csrf-token":csrf()},body:JSON.stringify(payload)});
  const d=await r.json().catch(()=>({}));
  if(r.status===401){location.href="login.html";return}
  if(!r.ok)throw new Error(d.error==="duplicate_record"?"شماره پرونده تکراری است.":d.error==="case_not_found"?"پرونده پیدا نشد.":"ذخیره پرونده انجام نشد.");
  message(caseId?"تغییرات با موفقیت ذخیره شد.":"پرونده با موفقیت ثبت شد.",true); setTimeout(()=>location.href=`case-profile.html?id=${encodeURIComponent(d.data.id)}`,500);
 }catch(e){message(e.message||"خطا در ارتباط با سرور.")}finally{btn.disabled=false;btn.textContent=caseId?"ذخیره تغییرات":"ذخیره پرونده"}
}
form.addEventListener("submit",save); loadCase();