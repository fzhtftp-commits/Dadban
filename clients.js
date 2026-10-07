document.addEventListener("DOMContentLoaded", () => {
  const search = document.getElementById("clientSearch");
  const filter = document.getElementById("clientFilter");
  const rows = Array.from(document.querySelectorAll("#clientsTable tbody tr"));
  const empty = document.getElementById("emptyClients");

  const apply = () => {
    const query = (search.value || "").trim().toLowerCase();
    const status = filter.value;
    let visible = 0;

    rows.forEach((row) => {
      const matchesText = row.textContent.toLowerCase().includes(query);
      const matchesStatus = status === "all" || row.dataset.status === status;
      const show = matchesText && matchesStatus;
      row.hidden = !show;
      if (show) visible++;
    });

    empty.hidden = visible !== 0;
  };

  search?.addEventListener("input", apply);
  filter?.addEventListener("change", apply);

  document.getElementById("newClient")?.addEventListener("click", () => {
    alert("فرم ثبت موکل جدید در مرحله بعد به دیتابیس متصل می‌شود.");
  });
});
