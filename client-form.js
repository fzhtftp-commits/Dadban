const API = "https://dadban-backend.onrender.com";

document.addEventListener("DOMContentLoaded", async () => {
  const form = document.getElementById("clientForm");
  const radios = document.querySelectorAll('input[name="clientType"]');
  const individual = document.getElementById("individualFields");
  const company = document.getElementById("companyFields");
  const message = document.getElementById("formMessage");
  const submitButton = document.getElementById("submitButton");
  const fullName = document.getElementById("fullName");
  const nationalId = document.getElementById("nationalId");
  const companyName = document.getElementById("companyName");
  const companyId = document.getElementById("companyId");
  const birthDate = document.getElementById("birthDate");
  const params = new URLSearchParams(window.location.search);
  const editMode = params.get("mode") === "edit";
  const clientId = params.get("id");

  const normalizeDigits = (value) => String(value || "")
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 1776))
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 1632));

  const showMessage = (text, ok = false) => {
    message.textContent = text;
    message.hidden = false;
    message.classList.toggle("success-message", ok);
  };

  const jalaliToGregorian = (input) => {
    const value = normalizeDigits(input).replace(/-/g, "/").trim();
    const m = value.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    if (!m) return null;
    let jy = Number(m[1]), jm = Number(m[2]), jd = Number(m[3]);
    if (jm < 1 || jm > 12 || jd < 1 || jd > 31) return null;
    jy -= 979;
    const jDayNo = 365 * jy + Math.floor(jy / 33) * 8 + Math.floor((jy % 33 + 3) / 4);
    for (let i = 1; i < jm; i++) jDayNo += i <= 6 ? 31 : 30;
    jDayNo += jd - 1;
    let gDayNo = jDayNo + 79;
    let gy = 1600 + 400 * Math.floor(gDayNo / 146097);
    gDayNo %= 146097;
    let leap = true;
    if (gDayNo >= 36525) {
      gDayNo--;
      gy += 100 * Math.floor(gDayNo / 36524);
      gDayNo %= 36524;
      if (gDayNo >= 365) gDayNo++;
      else leap = false;
    }
    gy += 4 * Math.floor(gDayNo / 1461);
    gDayNo %= 1461;
    if (gDayNo >= 366) {
      leap = false;
      gDayNo--;
      gy += Math.floor(gDayNo / 365);
      gDayNo %= 365;
    }
    let gd = gDayNo + 1;
    const monthDays = [31, (leap ? 29 : 28),31,30,31,30,31,31,30,31,30,31];
    let gm = 0;
    while (gd > monthDays[gm]) { gd -= monthDays[gm]; gm++; }
    return `${gy}-${String(gm + 1).padStart(2,"0")}-${String(gd).padStart(2,"0")}`;
  };

  const gregorianToJalali = (dateValue) => {
    if (!dateValue) return "";
    const parts = dateValue.slice(0,10).split("-").map(Number);
    if (parts.length !== 3 || parts.some(Number.isNaN)) return "";
    let [gy, gm, gd] = parts;
    gy -= 1600; gm -= 1; gd -= 1;
    const gDayNo = 365 * gy + Math.floor((gy + 3) / 4) - Math.floor((gy + 99) / 100) + Math.floor((gy + 399) / 400);
    const gMonthDays = [31, (gy % 4 === 0 && (gy % 100 !== 0 || gy % 400 === 0)) ? 29 : 28,31,30,31,30,31,31,30,31,30,31];
    let dayNo = gDayNo;
    for (let i=0;i<gm;i++) dayNo += gMonthDays[i];
    dayNo += gd;
    let jDayNo = dayNo - 79;
    let jy = 979 + 33 * Math.floor(jDayNo / 12053);
    jDayNo %= 12053;
    jy += 4 * Math.floor(jDayNo / 1461);
    jDayNo %= 1461;
    if (jDayNo >= 366) { jy += Math.floor((jDayNo - 1) / 365); jDayNo = (jDayNo - 1) % 365; }
    let jm = jDayNo < 186 ? 1 + Math.floor(jDayNo / 31) : 7 + Math.floor((jDayNo - 186) / 30);
    let jd = 1 + (jDayNo < 186 ? jDayNo % 31 : (jDayNo - 186) % 30);
    return `${jy}/${String(jm).padStart(2,"0")}/${String(jd).padStart(2,"0")}`;
  };

  const setType = (type) => {
    const isCompany = type === "company";
    individual.hidden = isCompany;
    company.hidden = !isCompany;
    individual.classList.toggle("form-hidden", isCompany);
    company.classList.toggle("form-hidden", !isCompany);
    fullName.required = !isCompany;
    nationalId.required = !isCompany;
    companyName.required = isCompany;
    companyId.required = isCompany;
    document.querySelectorAll(".type-option").forEach(item =>
      item.classList.toggle("active", item.querySelector("input").checked)
    );
  };

  const fillForm = (client) => {
    const type = client.client_type || "individual";
    const radio = document.querySelector(`input[name="clientType"][value="${type}"]`);
    if (radio) radio.checked = true;
    setType(type);
    fullName.value = client.full_name || "";
    nationalId.value = client.national_id || "";
    birthDate.value = gregorianToJalali(client.birth_date);
    document.getElementById("occupation").value = client.occupation || "";
    companyName.value = client.company_name || "";
    companyId.value = client.national_company_id || "";
    document.getElementById("registrationNo").value = client.registration_no || "";
    document.getElementById("mobile").value = client.mobile || "";
    document.getElementById("phone").value = client.phone || "";
    document.getElementById("email").value = client.email || "";
    document.getElementById("source").value = client.source || "";
    document.getElementById("address").value = client.address || "";
    document.getElementById("notes").value = client.notes || "";
  };

  if (editMode && !clientId) {
    showMessage("شناسه موکل برای ویرایش مشخص نیست.");
    submitButton.disabled = true;
    return;
  }

  if (editMode) {
    document.title = "دادبان | ویرایش موکل";
    document.getElementById("pageTitle").textContent = "ویرایش اطلاعات موکل";
    document.getElementById("formTitle").textContent = "ویرایش اطلاعات موکل";
    document.getElementById("formSubtitle").textContent = "اطلاعات از دیتابیس دریافت می‌شود و تغییرات به‌صورت امن ذخیره خواهد شد.";
    submitButton.textContent = "ذخیره تغییرات";
    document.getElementById("cancelLink").href = `client-profile.html?id=${encodeURIComponent(clientId)}`;
    try {
      const response = await fetch(`${API}/api/clients/${encodeURIComponent(clientId)}`, {credentials:"include"});
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) { window.location.href = "login.html"; return; }
      if (!response.ok) throw new Error("دریافت اطلاعات موکل انجام نشد.");
      fillForm(data.data);
    } catch (error) {
      showMessage(error.message || "خطا در دریافت اطلاعات موکل.");
      submitButton.disabled = true;
      return;
    }
  }

  radios.forEach(radio => radio.addEventListener("change", () => setType(radio.value)));
  setType(document.querySelector('input[name="clientType"]:checked')?.value || "individual");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    message.hidden = true;
    message.classList.remove("success-message");

    if (!form.checkValidity()) { form.reportValidity(); return; }

    const selected = document.querySelector('input[name="clientType"]:checked').value;
    const nationalIdValue = String(nationalId.value || "").trim();
    if (selected === "individual" && !/^[0-9۰-۹٠-٩]{10}$/.test(nationalIdValue)) {
      showMessage("کد ملی باید دقیقاً ۱۰ رقم باشد.");
      nationalId.focus();
      return;
    }

    const mobileValue = normalizeDigits(document.getElementById("mobile").value).replace(/[^0-9]/g, "");
    if (!/^09\d{9}$/.test(mobileValue)) {
      showMessage("شماره موبایل معتبر وارد کنید.");
      document.getElementById("mobile").focus();
      return;
    }

    const emailValue = document.getElementById("email").value.trim();
    const payload = {
      client_type: selected,
      full_name: selected === "individual" ? fullName.value.trim() : null,
      national_id: selected === "individual" ? normalizeDigits(nationalIdValue) : null,
      birth_date: selected === "individual" ? jalaliToGregorian(birthDate.value) : null,
      occupation: selected === "individual" ? document.getElementById("occupation").value.trim() || null : null,
      company_name: selected === "company" ? companyName.value.trim() : null,
      national_company_id: selected === "company" ? normalizeDigits(companyId.value.trim()) : null,
      registration_no: selected === "company" ? document.getElementById("registrationNo").value.trim() || null : null,
      mobile: mobileValue,
      phone: normalizeDigits(document.getElementById("phone").value).trim() || null,
      email: emailValue || null,
      source: document.getElementById("source").value || null,
      address: document.getElementById("address").value.trim() || null,
      notes: document.getElementById("notes").value.trim() || null,
      status: "active"
    };

    const csrf = sessionStorage.getItem("dadban_csrf");
    if (!csrf) { showMessage("نشست امنیتی منقضی شده است. دوباره وارد شوید."); return; }

    submitButton.disabled = true;
    submitButton.textContent = editMode ? "در حال ذخیره..." : "در حال ثبت...";

    try {
      const response = await fetch(editMode ? `${API}/api/clients/${encodeURIComponent(clientId)}` : `${API}/api/clients`, {
        method: editMode ? "PATCH" : "POST",
        credentials: "include",
        headers: {"Content-Type":"application/json","x-csrf-token":csrf},
        body: JSON.stringify(payload)
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) { window.location.href = "login.html"; return; }
      if (response.status === 403) throw new Error("درخواست امنیتی رد شد؛ صفحه را تازه‌سازی و دوباره وارد شوید.");
      if (!response.ok) {
        if (data.error === "invalid_client") throw new Error("اطلاعات موکل معتبر نیست.");
        if (data.error === "duplicate_client_identifier") throw new Error("کد ملی یا شناسه ملی قبلاً در این دفتر ثبت شده است.");
        throw new Error("ذخیره اطلاعات موکل انجام نشد.");
      }
      showMessage(editMode ? "اطلاعات موکل با موفقیت در دیتابیس ذخیره شد." : "موکل با موفقیت در دیتابیس ثبت شد.", true);
      const savedId = data?.data?.id || clientId;
      setTimeout(() => {
        window.location.href = editMode ? `client-profile.html?id=${encodeURIComponent(savedId)}` : `client-profile.html?id=${encodeURIComponent(savedId)}`;
      }, 500);
    } catch (error) {
      showMessage(error.message || "خطا در ارتباط با سرور.");
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = editMode ? "ذخیره تغییرات" : "ثبت موکل";
    }
  });
});