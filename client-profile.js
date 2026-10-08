const API = "https://dadban-backend.onrender.com";

document.addEventListener("DOMContentLoaded", async () => {
  const id = new URLSearchParams(window.location.search).get("id");
  const message = document.getElementById("profileMessage");
  const editButton = document.getElementById("editClient");
  const deleteButton = document.getElementById("deleteClient");
  const csrfToken = () => sessionStorage.getItem("dadban_csrf") || "";
  const faDigits = d => "۰۱۲۳۴۵۶۷۸۹"[d];
  const statusLabel = {active:"فعال",pending:"در انتظار",closed:"بسته",archived:"بایگانی"};
  const priorityLabel = {low:"کم",normal:"عادی",high:"بالا",urgent:"فوری"};

  const formatDigits = value => String(value ?? "").replace(/\d/g, d => faDigits(Number(d)));
  const formatDate = value => {
    if (!value) return "—";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "—";
    return new Intl.DateTimeFormat("fa-IR", {year:"numeric",month:"2-digit",day:"2-digit"}).format(d);
  };
  const jalaliFromIso = value => formatDate(value);
  const setText = (idName, value) => { document.getElementById(idName).textContent = value || "—"; };

  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[ch]));

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
    const casesUrl = new URL(`${API}/api/cases`);
    casesUrl.searchParams.set("client_id", id);
    casesUrl.searchParams.set("limit", "100");
    const casesResponse = await fetch(casesUrl.toString(), {credentials:"include"});
    const casesData = await casesResponse.json().catch(() => ({}));
    if (casesResponse.status === 401) { window.location.href = "login.html"; return; }
    if (!casesResponse.ok) throw new Error("دریافت پرونده‌های موکل انجام نشد.");
    const clientCases = Array.isArray(casesData?.data) ? casesData.data : [];
    const caseCount = document.getElementById("clientCasesCount");
    if (caseCount) caseCount.textContent = formatDigits(clientCases.length);
    const casesBody = document.getElementById("clientCasesBody");
    const casesEmpty = document.getElementById("clientCasesEmpty");
    if (casesBody) {
      casesBody.innerHTML = clientCases.length ? clientCases.map(item => {
        const status = statusLabel[item.status] || item.status || "—";
        const priority = priorityLabel[item.priority] || item.priority || "—";
        const statusClass = item.status === "active" ? "green" : "gold";
        return `<tr>
          <td><a href="case-profile.html?id=${encodeURIComponent(item.id)}"><b>${escapeHtml(item.case_number || "—")}</b></a></td>
          <td>${escapeHtml(item.title || "—")}</td>
          <td>${escapeHtml(item.case_type || "—")}</td>
          <td><span class="status ${statusClass}">${escapeHtml(status)}</span></td>
          <td>${escapeHtml(priority)}</td>
          <td>${escapeHtml(formatDate(item.next_hearing_at))}</td>
        </tr>`;
      }).join("") : "";
    }
    if (casesEmpty) casesEmpty.hidden = clientCases.length !== 0;

    document.getElementById("profileStatus").textContent =
      c.status === "needs_followup" ? "● نیازمند پیگیری" : c.status === "inactive" ? "● غیرفعال" : "● فعال";
    editButton.disabled = false;
    if (deleteButton) deleteButton.disabled = false;
    editButton.onclick = () => {
      window.location.href = `client-form.html?mode=edit&id=${encodeURIComponent(id)}`;
    };
    if (deleteButton) {
      deleteButton.onclick = async () => {
        const confirmed = window.confirm("آیا از حذف این موکل مطمئن هستید؟\n\nاین عملیات حذف نرم است و اطلاعات برای سوابق امنیتی نگهداری می‌شود.");
        if (!confirmed) return;
        deleteButton.disabled = true;
        editButton.disabled = true;
        deleteButton.textContent = "در حال حذف...";
        message.hidden = true;
        try {
          const token = csrfToken();
          if (!token) throw new Error("نشست امنیتی معتبر نیست. لطفاً دوباره وارد شوید.");
          const deleteResponse = await fetch(`${API}/api/clients/${encodeURIComponent(id)}`, {
            method: "DELETE",
            credentials: "include",
            headers: { "x-csrf-token": token }
          });
          const deleteData = await deleteResponse.json().catch(() => ({}));
          if (deleteResponse.status === 401) { window.location.href = "login.html"; return; }
          if (deleteResponse.status === 403) throw new Error("درخواست حذف از نظر امنیتی تأیید نشد. صفحه را تازه‌سازی کنید.");
          if (!deleteResponse.ok) throw new Error(deleteData?.error || "حذف موکل انجام نشد.");
          window.location.href = "clients.html?deleted=1";
        } catch (error) {
          message.textContent = error.message || "خطا در ارتباط با سرور.";
          message.hidden = false;
          deleteButton.disabled = false;
          editButton.disabled = false;
          deleteButton.textContent = "حذف موکل";
        }
      };
    }
  } catch (error) {
    message.textContent = error.message || "خطا در ارتباط با سرور.";
    message.hidden = false;
  }
});