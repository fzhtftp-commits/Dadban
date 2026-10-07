document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("clientForm");
  const radios = document.querySelectorAll('input[name="clientType"]');
  const individual = document.getElementById("individualFields");
  const company = document.getElementById("companyFields");
  const message = document.getElementById("formMessage");
  const fullName = document.getElementById("fullName");
  const nationalId = document.getElementById("nationalId");
  const companyName = document.getElementById("companyName");
  const companyId = document.getElementById("companyId");
  const editMode = new URLSearchParams(window.location.search).get("mode") === "edit";

  const normalizeDigits = (value) => String(value || "")
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - "۰".charCodeAt(0)))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - "٠".charCodeAt(0)));

  const digitsOnly = (value) => normalizeDigits(value).replace(/[^0-9]/g, "");

  const setType = (type) => {
    const isCompany = type === "company";
    individual.classList.toggle("form-hidden", isCompany);
    company.classList.toggle("form-hidden", !isCompany);
    individual.hidden = isCompany;
    company.hidden = !isCompany;
    fullName.required = !isCompany;
    nationalId.required = !isCompany;
    companyName.required = isCompany;
    companyId.required = isCompany;
    document.querySelectorAll(".type-option").forEach((item) =>
      item.classList.toggle("active", item.querySelector("input").checked)
    );
  };

  if (editMode) {
    document.title = "دادبان | ویرایش اطلاعات موکل";
    document.getElementById("pageTitle").textContent = "ویرایش اطلاعات موکل";
    document.getElementById("formTitle").textContent = "ویرایش اطلاعات علی رضایی";
    document.getElementById("formSubtitle").textContent = "اطلاعات فعلی موکل بارگذاری شده است. در این مرحله تغییرات فقط اعتبارسنجی می‌شوند و هنوز دائمی ذخیره نمی‌شوند.";
    document.getElementById("submitButton").textContent = "بررسی و ذخیره تغییرات";
    document.getElementById("cancelLink").href = "client-profile.html";
    fullName.value = "علی رضایی";
    nationalId.value = "۰۰۱۲۳۴۵۶۷۸";
    document.getElementById("birthDate").value = "۱۳۷۰/۰۵/۲۰";
    document.getElementById("occupation").value = "مهندس";
    document.getElementById("mobile").value = "09121234567";
    document.getElementById("phone").value = "02112345678";
    document.getElementById("email").value = "ali@example.com";
    document.getElementById("source").value = "معرفی";
    document.getElementById("address").value = "تهران، خیابان نمونه، پلاک ۱۲";
    document.getElementById("notes").value = "پیگیری پرونده‌های جاری";
  }

  radios.forEach((radio) => radio.addEventListener("change", () => setType(radio.value)));
  setType(document.querySelector('input[name="clientType"]:checked')?.value || "individual");

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    message.hidden = true;
    message.classList.remove("success-message");
    message.textContent = "";

    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    const selected = document.querySelector('input[name="clientType"]:checked').value;
    const nationalIdDigits = digitsOnly(nationalId.value);

    if (selected === "individual" && !/^\d{10}$/.test(nationalIdDigits)) {
      message.textContent = "کد ملی باید دقیقاً ۱۰ رقم باشد.";
      message.hidden = false;
      nationalId.focus();
      return;
    }

    const mobileDigits = digitsOnly(document.getElementById("mobile").value);
    if (!/^09\d{9}$/.test(mobileDigits)) {
      message.textContent = "شماره موبایل معتبر وارد کنید.";
      message.hidden = false;
      document.getElementById("mobile").focus();
      return;
    }

    message.textContent = editMode
      ? "اطلاعات ویرایش‌شده با موفقیت اعتبارسنجی شد؛ ذخیره دائمی پس از اتصال امن به دیتابیس فعال می‌شود."
      : "اطلاعات فرم با موفقیت اعتبارسنجی شد. ذخیره واقعی پس از اتصال امن به دیتابیس انجام می‌شود.";
    message.hidden = false;
    message.classList.add("success-message");
  });
});