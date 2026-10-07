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

  const setType = (type) => {
    const isCompany = type === "company";
    individual.hidden = isCompany;
    company.hidden = !isCompany;
    fullName.required = !isCompany;
    nationalId.required = !isCompany;
    companyName.required = isCompany;
    companyId.required = isCompany;
    document.querySelectorAll(".type-option").forEach((item) => item.classList.toggle("active", item.querySelector("input").checked));
  };

  radios.forEach((radio) => radio.addEventListener("change", () => setType(radio.value)));
  setType("individual");

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    message.hidden = true;
    message.textContent = "";

    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    const numeric = (value) => value.replace(/\D/g, "");
    const selected = document.querySelector('input[name="clientType"]:checked').value;

    if (selected === "individual" && numeric(nationalId.value).length !== 10) {
      message.textContent = "کد ملی باید دقیقاً ۱۰ رقم باشد.";
      message.hidden = false;
      nationalId.focus();
      return;
    }

    if (!/^09\d{9}$/.test(numeric(document.getElementById("mobile").value))) {
      message.textContent = "شماره موبایل معتبر وارد کنید.";
      message.hidden = false;
      document.getElementById("mobile").focus();
      return;
    }

    message.textContent = "اطلاعات فرم با موفقیت اعتبارسنجی شد. ذخیره واقعی پس از اتصال امن به دیتابیس انجام می‌شود.";
    message.hidden = false;
    message.classList.add("success-message");
  });
});