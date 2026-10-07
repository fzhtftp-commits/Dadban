const toast = (text) => {
  let el = document.getElementById("dadbanToast");
  if (!el) {
    el = document.createElement("div");
    el.id = "dadbanToast";
    el.className = "dadban-toast";
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(window.__dadbanToastTimer);
  window.__dadbanToastTimer = setTimeout(() => el.classList.remove("show"), 2200);
};

const labels = {
  "موکل‌ها": "بخش موکل‌ها",
  "پرونده‌ها": "بخش پرونده‌ها",
  "تقویم و جلسات": "تقویم و جلسات",
  "اقدامات پرونده": "اقدامات پرونده",
  "اسناد و مدارک": "اسناد و مدارک",
  "امور مالی": "امور مالی",
  "گزارش‌ها": "گزارش‌ها",
  "تنظیمات": "تنظیمات"
};

document.querySelectorAll(".sidebar nav a, .side-bottom a").forEach((a) => {
  a.addEventListener("click", (e) => {
    e.preventDefault();
    document.querySelectorAll(".sidebar nav a, .side-bottom a").forEach((x) => x.classList.remove("active"));
    a.classList.add("active");
    const textValue = a.textContent.replace(/^\S+\s*/, "").trim();
    if (textValue !== "داشبورد") toast((labels[textValue] || textValue) + " در حال آماده‌سازی است.");
  });
});

document.querySelector(".primary")?.addEventListener("click", () => {
  toast("فرم ثبت پرونده جدید به‌زودی به دیتابیس متصل می‌شود.");
});

document.querySelector(".icon-btn")?.addEventListener("click", () => {
  toast("فعلاً اعلان جدیدی وجود ندارد.");
});

document.querySelectorAll(".section-head a").forEach((a) => {
  a.addEventListener("click", (e) => {
    e.preventDefault();
    toast(a.textContent.trim() + " در حال آماده‌سازی است.");
  });
});

const style = document.createElement("style");
style.textContent = `
.dadban-toast {
  position: fixed;
  left: 24px;
  bottom: 24px;
  z-index: 9999;
  background: #101b35;
  color: #fff;
  border: 1px solid #c8a24a;
  border-radius: 12px;
  padding: 13px 18px;
  box-shadow: 0 12px 35px rgba(0,0,0,.22);
  opacity: 0;
  transform: translateY(12px);
  pointer-events: none;
  transition: .25s ease;
  font-size: 14px;
}
.dadban-toast.show { opacity: 1; transform: translateY(0); }
.sidebar nav a.active, .side-bottom a.active { color: #c8a24a; }
`;
document.head.appendChild(style);
