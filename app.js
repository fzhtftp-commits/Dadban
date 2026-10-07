document.addEventListener("DOMContentLoaded", () => {
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
});
