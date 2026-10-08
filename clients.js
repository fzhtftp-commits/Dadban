const API = "https://dadban-backend.onrender.com";

document.addEventListener("DOMContentLoaded", async () => {
  const search = document.getElementById("clientSearch");
  const filter = document.getElementById("clientFilter");
  const body = document.getElementById("clientsBody");
  const empty = document.getElementById("emptyClients");
  const errorBox = document.getElementById("clientsError");
  const statusText = document.getElementById("clientsStatus");
  const rowsData = [];

  const toFa = (value) => String(value ?? "").replace(/\d/g, d => "۰۱۲۳۴۵۶۷۸۹"[d]);
  const formatDate = (value) => {
    if (!value) return "—";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "—";
    return new Intl.DateTimeFormat("fa-IR", {year:"numeric",month:"2-digit",day:"2-digit"}).format(d);
  };
  const statusLabel = {active:"فعال", needs_followup:"نیازمند پیگیری", inactive:"غیرفعال"};
  const statusClass = {active:"green", needs_followup:"gold", inactive:""};

  const render = () => {
    const query = (search.value || "").trim().toLowerCase();
    const selected = filter.value;
    body.innerHTML = "";
    let visible = 0;

    rowsData.forEach((client) => {
      const haystack = [
        client.full_name, client.company_name, client.national_id,
        client.national_company_id, client.mobile, client.phone, client.email
      ].join(" ").toLowerCase();
      const matchesText = haystack.includes(query);
      const matchesStatus = selected === "all" || client.status === selected;
      if (!matchesText || !matchesStatus) return;

      visible++;
      const tr = document.createElement("tr");
      const name = client.client_type === "company" ? client.company_name : client.full_name;
      const id = client.client_type === "company" ? client.national_company_id : client.national_id;
      const phone = client.mobile || client.phone || "—";
      const type = client.client_type === "company" ? "حقوقی" : "حقیقی";
      tr.innerHTML =
        `<td><a class="client-profile-link" href="client-profile.html?id=${encodeURIComponent(client.id)}"><b>${escapeHtml(name || "بدون نام")}</b></a></td>
         <td class="ltr-value">${escapeHtml(toFa(id || "—"))}</td>
         <td class="ltr-value">${escapeHtml(phone || "—")}</td>
         <td>${type}</td>
         <td>${formatDate(client.updated_at || client.created_at)}</td>
         <td><span class="status ${statusClass[client.status] || ""}">${statusLabel[client.status] || client.status}</span></td>`;
      body.appendChild(tr);
    });
    empty.hidden = visible !== 0;
  };

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[ch]));

  try {
    const response = await fetch(`${API}/api/clients?limit=100`, {credentials:"include"});
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) { window.location.href = "login.html"; return; }
    if (!response.ok) throw new Error("دریافت فهرست موکل‌ها انجام نشد.");
    rowsData.push(...(data.data || []));
    const total = rowsData.length;
    document.getElementById("totalClients").textContent = toFa(total);
    document.getElementById("activeClients").textContent = toFa(rowsData.filter(x=>x.status==="active").length);
    document.getElementById("followupClients").textContent = toFa(rowsData.filter(x=>x.status==="needs_followup").length);
    statusText.textContent = `${toFa(total)} موکل از دیتابیس دریافت شد.`;
    render();
  } catch (error) {
    statusText.textContent = "خطا در دریافت اطلاعات";
    errorBox.textContent = error.message || "خطا در ارتباط با سرور.";
    errorBox.hidden = false;
  }

  search?.addEventListener("input", render);
  filter?.addEventListener("change", render);
});