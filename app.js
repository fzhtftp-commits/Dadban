const API = "https://dadban-backend.onrender.com";

document.addEventListener("DOMContentLoaded", async () => {
  const links = document.querySelectorAll(".sidebar nav a, .side-bottom a");

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
    const response = await fetch(`${API}/api/auth/me`, {
      credentials: "include"
    });

    if (!response.ok) {
      sessionStorage.removeItem("dadban_user");
      sessionStorage.removeItem("dadban_csrf");
      window.location.href = "login.html";
      return;
    }

    const data = await response.json();
    if (data?.data?.user) {
      sessionStorage.setItem("dadban_user", JSON.stringify(data.data.user));

      const name = document.querySelector(".user b");
      const role = document.querySelector(".user small");

      if (name) name.textContent = data.data.user.full_name;
      if (role) role.textContent = data.data.user.role === "owner" ? "مالک دفتر" : data.data.user.role;
    }
  } catch {
    // Keep the page usable if the API is temporarily unreachable.
    // Protected API actions will still require a valid session.
  }
});
