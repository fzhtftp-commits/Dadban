const API = "https://dadban-backend.onrender.com";

const form = document.getElementById("loginForm");
const password = document.getElementById("password");
const toggle = document.getElementById("toggle");
const message = document.getElementById("message");
const submit = form?.querySelector(".submit");

const setMessage = (text, ok = false) => {
  if (!message) return;
  message.textContent = text;
  message.style.color = ok ? "#39734d" : "#b24b4b";
};

toggle?.addEventListener("click", () => {
  const show = password.type === "password";
  password.type = show ? "text" : "password";
  toggle.textContent = show ? "پنهان" : "نمایش";
});

form?.addEventListener("submit", async (event) => {
  event.preventDefault();

  const email = document.getElementById("email")?.value.trim();
  const passwordValue = password?.value || "";

  if (!email || !passwordValue) {
    setMessage("ایمیل و رمز عبور را وارد کنید.");
    return;
  }

  submit.disabled = true;
  submit.textContent = "در حال ورود...";
  setMessage("");

  try {
    const response = await fetch(`${API}/api/auth/login`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password: passwordValue
      })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error("ایمیل یا رمز عبور نادرست است.");
      }
      throw new Error("ورود انجام نشد. لطفاً دوباره تلاش کنید.");
    }

    if (data?.data?.csrf_token) {
      sessionStorage.setItem("dadban_csrf", data.data.csrf_token);
    }

    const me = await fetch(`${API}/api/auth/me`, {
      credentials: "include"
    });

    if (!me.ok) {
      throw new Error("جلسه ورود ایجاد نشد. دوباره تلاش کنید.");
    }

    const meData = await me.json();
    sessionStorage.setItem("dadban_user", JSON.stringify(meData.data.user));

    setMessage("ورود با موفقیت انجام شد؛ در حال انتقال...", true);
    window.setTimeout(() => {
      window.location.href = "index.html";
    }, 400);
  } catch (error) {
    setMessage(error.message || "خطا در ارتباط با سرور.");
  } finally {
    submit.disabled = false;
    submit.textContent = "ورود به دادبان";
  }
});
