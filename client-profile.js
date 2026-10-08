const API = "https://dadban-backend.onrender.com";

document.addEventListener("DOMContentLoaded", async () => {
  const id = new URLSearchParams(window.location.search).get("id");
  const message = document.getElementById("profileMessage");
  const editButton = document.getElementById("editClient");
  const faDigits = d => "۰۱۲۳۴۵۶۷۸۹"[d];

  const formatDigits = value => String(value ?? "").replace(/\d/g, d => faDigits(Number(d)));
  const formatDate = value => {
    if (!value) return "—";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "—";
    return new Intl.DateTimeFormat("fa-IR", {year:"numeric",month:"2-digit",day:"2-digit"}).format(d);
  };
  const jalaliFromIso = value => formatDate(value);
  const setText = (idName, value) => { document.getElementById(idName).textContent = value || "—"; };

  if (!id) {
    message.textContent = "شناسه موکل در آدرس صفحه وجود ندارد.";
    message.hidden = false;
    return;
  }

  try {
    const response = await fetch(`${API}/api/clients/${encodeURIComponent(id)}`, {credentials:"include"});
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) { window.location.href = "login.html"; return; }
    if (!response.ok) throw new Error("اطلاعات موکل پیدا نشد.");
    const c = data.data;
    const isCompany = c.client_type === "company";
    const name = isCompany ? c.company_name : c.full_name;
    const identifier = isCompany ? c.national_company_id : c.national_id;

    document.title = `دادبان | ${name || "پروفایل موکل"}`;
    setText("profileName", name);
    document.getElementById("profileAvatar").textContent = String(name || "م").trim().charAt(0);
    setText("profileIdentifier", `${isCompany ? "شناسه ملی" : "کد ملی"}: ${formatDigits(identifier)}`);
    setText("dName", name);
    setText("dId", formatDigits(identifier));
    setText("dBirth", isCompany ? "—" : jalaliFromIso(c.birth_date));
    setText("dOccupation", isCompany ? "—" : c.occupation);
    setText("dMobile", formatDigits(c.mobile));
    setText("dPhone", formatDigits(c.phone));
    setText("dEmail", c.email);
    setText("dAddress", c.address);
    setText("dNotes", c.notes);
    setText("dUpdated", formatDate(c.updated_at || c.created_at));
    document.getElementById("profileStatus").textContent =
      c.status === "needs_followup" ? "● نیازمند پیگیری" : c.status === "inactive" ? "● غیرفعال" : "● فعال";
    editButton.disabled = false;
    editButton.onclick = () => {
      window.location.href = `client-form.html?mode=edit&id=${encodeURIComponent(id)}`;
    };
  } catch (error) {
    message.textContent = error.message || "خطا در ارتباط با سرور.";
    message.hidden = false;
  }
});