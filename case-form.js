const API="https://dadban-backend.onrender.com";
const form=document.getElementById("caseForm"),clientId=document.getElementById("client_id"),nationalId=document.getElementById("client_national_id"),lookupMessage=document.getElementById("clientLookupMessage"),msg=document.getElementById("formMessage"),btn=document.getElementById("saveCase");
const csrf=()=>sessionStorage.getItem("dadban_csrf")||"";
const message=(t,ok=false)=>{msg.hidden=false;msg.textContent=t;msg.className="form-message"+(ok?" success-message":"")};
const normalizeDigits=v=>String(v||"").replace(/[۰-۹]/g,d=>"۰۱۲۳۴۵۶۷۸۹".indexOf(d)).replace(/[٠-٩]/g,d=>"٠١٢٣٤٥٦٧٨٩".indexOf(d));
let lookupTimer;
async function lookupClient(){
 const value=normalizeDigits(nationalId.value).replace(/\D/g,"");
 nationalId.value=value;
 clientId.value="";
 if(value.length!==10){lookupMessage.textContent="کد ملی را وارد کنید تا نام موکل نمایش داده شود.";lookupMessage.style.color="";return}
 lookupMessage.textContent="در حال بررسی کد ملی...";
 try{
  const r=await fetch(`${API}/api/clients/lookup?national_id=${encodeURIComponent(value)}`,{credentials:"include"});
  if(r.status===401){location.href="login.html";return}
  const d=await r.json().catch(()=>({}));
  if(r.status===404){lookupMessage.textContent="موکلی با این کد ملی پیدا نشد.";lookupMessage.style.color="#b24b4b";return}
  if(!r.ok)throw new Error();
  clientId.value=d.data.id;
  lookupMessage.textContent=`موکل: ${d.data.full_name||d.data.company_name||"—"}`;
  lookupMessage.style.color="#39734d";
 }catch{lookupMessage.textContent="خطا در بررسی کد ملی.";lookupMessage.style.color="#b24b4b";}
}
nationalId.addEventListener("input",()=>{clearTimeout(lookupTimer);lookupTimer=setTimeout(lookupClient,350)});
async function save(e){
 e.preventDefault();
 if(!clientId.value){message("ابتدا کد ملی معتبر یک موکل موجود را وارد کنید.");return}
 btn.disabled=true;btn.textContent="در حال ذخیره...";
 try{
  const dt=document.getElementById("next_hearing_at").value;
  const payload={client_id:clientId.value,case_number:document.getElementById("case_number").value.trim(),title:document.getElementById("title").value.trim(),case_type:document.getElementById("case_type").value.trim()||null,court_name:document.getElementById("court_name").value.trim()||null,branch_name:document.getElementById("branch_name").value.trim()||null,opposing_party:document.getElementById("opposing_party").value.trim()||null,status:document.getElementById("status").value,priority:document.getElementById("priority").value,filing_date:document.getElementById("filing_date").value||null,next_hearing_at:dt?new Date(dt).toISOString():null,description:document.getElementById("description").value.trim()||null,notes:document.getElementById("notes").value.trim()||null};
  const r=await fetch(`${API}/api/cases`,{method:"POST",credentials:"include",headers:{"Content-Type":"application/json","x-csrf-token":csrf()},body:JSON.stringify(payload)});
  const d=await r.json().catch(()=>({}));
  if(r.status===401){location.href="login.html";return}
  if(!r.ok)throw new Error(d.error==="duplicate_record"?"شماره پرونده تکراری است.":"ثبت پرونده انجام نشد.");
  message("پرونده با موفقیت ثبت شد.",true);setTimeout(()=>location.href=`case-profile.html?id=${encodeURIComponent(d.data.id)}`,500)
 }catch(e){message(e.message||"خطا در ارتباط با سرور.")}finally{btn.disabled=false;btn.textContent="ذخیره پرونده"}
}
form.addEventListener("submit",save);