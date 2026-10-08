const API = "https://dadban-backend.onrender.com";

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({
  "&":"&amp;",
  "<":"&lt;",
  ">":"&gt;",
  '"':"&quot;",
  "'":"&#039;"
}[ch]));

const toFa = (value) => String(value ?? "").replace(/\d/g, d => "۰۱۲۳۴۵۶۷۸۹"[d]);

const formatDateTime = (value) => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("fa-IR", {
    year:"numeric", month:"2-digit", day:"2-digit",
    hour:"2-digit", minute:"2-digit"
  }).format(date);
};

const statusLabel = {
  active: "فعال",
  pending: "در انتظار",
  closed: "بسته",
  archived: "بایگانی"
};

document.addEventListener("DOMContentLoaded", async () => {
  const links = document.querySelectorAll(".sidebar nav a, .side-bottom a");
  const logoutButtons = [
    document.getElementById("logoutBtn"),
    document.getElementById("headerLogoutBtn")
  ].filter(Boolean);

  const performLogout = async (clickedButton) => {
    if (!window.confirm("آیا می‌خواهید از حساب دادبان خارج شوید؟")) return;

    logoutButtons.forEach((button) => {
      button.disabled = true;
      button.textContent = "در حال خروج...";
    });

    try {
      const csrf = sessionStorage.getItem("dadban_csrf") || "";
      const response = await fetch(`${API}/api/auth/logout`, {
        method: "POST",
        credentials: "include",
        headers: {
          "x-csrf-token": csrf
        }
      });

      if (!response.ok && response.status !== 401) {
        throw new Error("logout_failed");
      }
    } catch (error) {
      console.error("Logout failed:", error);
    } finally {
      sessionStorage.removeItem("dadban_user");
      sessionStorage.removeItem("dadban_csrf");
      window.location.href = "login.html";
    }
  };

  logoutButtons.forEach((button) => {
    button.addEventListener("click", () => performLogout(button));
  });

  links.forEach((link) => {
    link.addEventListener("click", (event) => {
      links.forEach((item) => item.classList.remove("active"));
      link.classList.add("active");

      const href = link.getAttribute("href");
      if (!href || href === "#") {
        event.preventDefault();
      }
    });
  });

  try {
    const meResponse = await fetch(`${API}/api/auth/me`, {
      credentials: "include"
    });

    if (!meResponse.ok) {
      sessionStorage.removeItem("dadban_user");
      sessionStorage.removeItem("dadban_csrf");
      window.location.href = "login.html";
      return;
    }

    const meData = await meResponse.json();
    if (meData?.data?.user) {
      sessionStorage.setItem("dadban_user", JSON.stringify(meData.data.user));

      const name = document.querySelector(".user b");
      const role = document.querySelector(".user small");

      if (name) name.textContent = meData.data.user.full_name || "مدیر دفتر";
      if (role) role.textContent = meData.data.user.role === "owner" ? "مالک دفتر" : (meData.data.user.role || "کاربر");
    }

    await loadDashboard();
  } catch (error) {
    const body = document.getElementById("recentCasesBody");
    const hearings = document.getElementById("upcomingHearingsBody");
    if (body) body.innerHTML = '<tr><td colspan="4" class="empty-state">دریافت اطلاعات داشبورد انجام نشد.</td></tr>';
    if (hearings) hearings.innerHTML = '<div class="empty-state">دریافت اطلاعات جلسات انجام نشد.</div>';
    console.error("Dashboard load failed:", error);
  }
});

async function loadDashboard() {
  const response = await fetch(`${API}/api/dashboard`, {
    credentials: "include"
  });

  if (response.status === 401) {
    window.location.href = "login.html";
    return;
  }

  if (!response.ok) {
    throw new Error("dashboard_api_failed");
  }

  const payload = await response.json();
  const data = payload?.data || {};
  const stats = data.stats || {};

  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = toFa(value ?? 0);
  };

  setText("activeCases", stats.active_cases);
  setText("totalClients", stats.total_clients);
  setText("upcomingHearings", stats.upcoming_hearings);
  setText("closedCases", stats.closed_cases);

  const recentBody = document.getElementById("recentCasesBody");
  const recentCases = Array.isArray(data.recent_cases) ? data.recent_cases : [];

  if (recentBody) {
    if (!recentCases.length) {
      recentBody.innerHTML = '<tr><td colspan="4" class="empty-state">هنوز پرونده‌ای ثبت نشده است.</td></tr>';
    } else {
      recentBody.innerHTML = recentCases.map((item) => {
        const client = item.client_full_name || item.client_company_name || "—";
        const statusClass = item.status === "active" ? "green" : "gold";
        return `<tr>
          <td><a href="case-profile.html?id=${encodeURIComponent(item.id)}">${escapeHtml(item.case_number || "—")}</a></td>
          <td>${escapeHtml(client)}</td>
          <td>${escapeHtml(item.case_type || "—")}</td>
          <td><span class="status ${statusClass}">${escapeHtml(statusLabel[item.status] || item.status || "—")}</span></td>
        </tr>`;
      }).join("");
    }
  }

  const hearingsBody = document.getElementById("upcomingHearingsBody");
  const hearings = Array.isArray(data.upcoming_hearings) ? data.upcoming_hearings : [];

  if (hearingsBody) {
    if (!hearings.length) {
      hearingsBody.innerHTML = '<div class="empty-state">جلسه پیش‌رویی ثبت نشده است.</div>';
    } else {
      hearingsBody.innerHTML = hearings.map((item) => {
        const location = [item.court_name, item.branch_name].filter(Boolean).join("، ") || "محل جلسه ثبت نشده";
        return `<div class="event">
          <b>${escapeHtml(item.title || "جلسه پرونده")}</b>
          <span>${escapeHtml(formatDateTime(item.next_hearing_at))}</span>
          <small>${escapeHtml(location)} · پرونده ${escapeHtml(item.case_number || "—")}</small>
        </div>`;
      }).join("");
    }
  }
}
