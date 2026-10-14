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

  const { normalizeDigits, isValidIranianNationalCode, jalaliToGregorian, gregorianToJalali, isValidJalaliDate } = window.DadbanFormValidation;

  const showMessage = (text, ok = false) => {
    message.textContent = text;
    message.hidden = false;
    message.classList.toggle("success-message", ok);
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
    showMessage("شناسه موکل برای ویرایش مشخص نیست. از صفحه پروفایل، دکمه ویرایش را دوباره بزنید.");
    submitButton.disabled = false;
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
      submitButton.disabled = false;
    }
  }

  // دکمه ذخیره همیشه قابل کلیک است؛ خطاهای دریافت اطلاعات هنگام ارسال دوباره بررسی می‌شوند.
  submitButton.disabled = false;

  radios.forEach(radio => radio.addEventListener("change", () => setType(radio.value)));
  setType(document.querySelector('input[name="clientType"]:checked')?.value || "individual");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    message.hidden = true;
    message.classList.remove("success-message");

    if (!form.checkValidity()) { form.reportValidity(); return; }

    const selected = document.querySelector('input[name="clientType"]:checked').value;
    const nationalIdValue = String(nationalId.value || "").trim();
    if (selected === "individual" && !isValidIranianNationalCode(nationalIdValue)) {
      showMessage("کد ملی معتبر وارد کنید؛ رقم کنترل کد ملی صحیح نیست.");
      nationalId.focus();
      return;
    }

    if (selected === "individual" && birthDate.value.trim() && !isValidJalaliDate(birthDate.value)) {
      showMessage("تاریخ تولد شمسی معتبر وارد کنید.");
      birthDate.focus();
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